// PDF -> book, with pdf.js (legacy build: includes polyfills for older Chrome versions).
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ParsedBook, Paragraph, Section } from './types';
import { itemsToLines, linesToParagraphs, stripRunningLines, type PdfItem, type PdfLine } from './pdf-layout';
import { capSections } from './text-utils';

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.mjs');

interface OutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items: OutlineNode[];
}

export async function parsePdf(data: ArrayBuffer, fallbackTitle: string, onProgress?: (done: number, total: number) => void): Promise<ParsedBook> {
  // Text extraction only: no font loading needed.
  const task = pdfjs.getDocument({ data: new Uint8Array(data), disableFontFace: true, useSystemFonts: false });
  const doc = await task.promise;
  try {
    const pages: PdfLine[][] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const items: PdfItem[] = [];
      for (const it of content.items as { str?: string; transform?: number[]; width?: number; height?: number }[]) {
        if (typeof it.str !== 'string' || !it.transform) continue;
        const [, , c, d, e, f] = it.transform;
        items.push({ str: it.str, x: e, y: f, w: it.width ?? 0, h: it.height || Math.hypot(c, d) });
      }
      pages.push(itemsToLines(items));
      page.cleanup();
      onProgress?.(n, doc.numPages);
    }
    const paragraphs = linesToParagraphs(stripRunningLines(pages));
    if (!paragraphs.length) throw new Error('This PDF has no text layer (it is probably scanned images).');

    const meta = (await doc.getMetadata().catch(() => null)) as { info?: { Title?: string; Author?: string } } | null;
    const rawTitle = meta?.info?.Title?.trim() ?? '';
    // Many PDFs carry junk titles (the generator's page URL, "Untitled", a file path…).
    const goodMeta = rawTitle && !/^(about:blank|untitled|document\d*|microsoft word\b.*)$/i.test(rawTitle) && !/[\\/]|\.(docx?|pdf|indd)$/i.test(rawTitle);
    // Otherwise the first big heading on the first pages is usually the real title.
    const firstHeading = paragraphs.find((p) => p.h === 1 && (p.p ?? 1) <= 2 && p.t.length <= 100)?.t;
    const title = goodMeta ? rawTitle : firstHeading ?? fallbackTitle;
    const sections = await splitSections(doc, paragraphs, title);
    return { title, author: meta?.info?.Author?.trim() || undefined, sections: capSections(sections) };
  } finally {
    task.destroy();
  }
}

async function splitSections(doc: pdfjs.PDFDocumentProxy, paragraphs: Paragraph[], title: string): Promise<Section[]> {
  // 1. PDF outline (bookmarks) -> chapters by page.
  let outline = ((await doc.getOutline().catch(() => null)) ?? []) as OutlineNode[];
  // A single top-level entry (usually the book title) holds the chapters: go down to them.
  while (outline.length === 1 && outline[0].items?.length) outline = outline[0].items;
  const marks: { title: string; page: number }[] = [];
  for (const node of outline) {
    try {
      const dest = typeof node.dest === 'string' ? await doc.getDestination(node.dest) : node.dest;
      if (!Array.isArray(dest) || !dest[0]) continue;
      const page = (await doc.getPageIndex(dest[0] as Parameters<typeof doc.getPageIndex>[0])) + 1;
      marks.push({ title: node.title, page });
    } catch {
      /* broken bookmark */
    }
  }
  marks.sort((a, b) => a.page - b.page);
  if (marks.length >= 2) {
    const sections: Section[] = [];
    marks.forEach((m, i) => {
      const end = marks[i + 1]?.page ?? Infinity;
      const ps = paragraphs.filter((p) => (p.p ?? 0) >= m.page && (p.p ?? 0) < end);
      if (ps.length) sections.push({ title: m.title, paragraphs: ps });
    });
    const before = paragraphs.filter((p) => (p.p ?? 0) < marks[0].page);
    if (before.length) sections.unshift({ title, paragraphs: before });
    if (sections.length) return sections;
  }
  // 2. Large headings: split on the biggest heading level that appears at least twice.
  const count = (h: number) => paragraphs.filter((p) => p.h === h).length;
  const level = count(1) >= 2 ? 1 : count(2) >= 2 ? 2 : 0;
  const sections: Section[] = [];
  let cur: Section = { title, paragraphs: [] };
  for (const p of paragraphs) {
    if (level && p.h === level && cur.paragraphs.some((x) => !x.h)) {
      sections.push(cur);
      cur = { title: p.t.slice(0, 80), paragraphs: [] };
    } else if (level && p.h === level && !cur.paragraphs.some((x) => !x.h)) cur.title = p.t.slice(0, 80);
    cur.paragraphs.push(p);
  }
  sections.push(cur);
  if (sections.length > 1) return sections;
  // 3. Fixed page ranges.
  const out: Section[] = [];
  const lastPage = paragraphs[paragraphs.length - 1].p ?? 1;
  for (let start = 1; start <= lastPage; start += 10) {
    const ps = paragraphs.filter((p) => (p.p ?? 1) >= start && (p.p ?? 1) < start + 10);
    if (ps.length) out.push({ title: `${start}–${Math.min(lastPage, start + 9)}`, paragraphs: ps });
  }
  return out;
}
