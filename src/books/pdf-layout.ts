// Rebuilds reading order and paragraphs from positioned PDF text items (pure functions, unit-tested).
import type { Paragraph } from './types';

export interface PdfItem {
  str: string;
  x: number;
  /** Baseline y in PDF units (grows upwards). */
  y: number;
  w: number;
  h: number;
}

export interface PdfLine {
  text: string;
  x: number;
  y: number;
  h: number;
  right: number;
}

const NO_SPACE_SCRIPT = /[぀-ヿ㐀-鿿가-힯฀-๿]/;

export function itemsToLines(items: PdfItem[]): PdfLine[] {
  const sorted = items
    .map((i) => ({ ...i, str: i.str.replace(/\u00ad/g, '') }))
    .filter((i) => i.str.length)
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: { y: number; h: number; items: PdfItem[] }[] = [];
  for (const it of sorted) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last.y - it.y) <= Math.max(1.5, Math.min(last.h || it.h, it.h || last.h) * 0.45)) last.items.push(it);
    else groups.push({ y: it.y, h: it.h, items: [it] });
  }
  return groups
    .map((g) => {
      const its = g.items.sort((a, b) => a.x - b.x);
      let text = '';
      let prevRight = -Infinity;
      for (const it of its) {
        const gap = it.x - prevRight;
        const needsSpace = text && gap > Math.max(it.h, g.h) * 0.18 && !/\s$/.test(text) && !/^\s/.test(it.str) && !(NO_SPACE_SCRIPT.test(text.slice(-1)) && NO_SPACE_SCRIPT.test(it.str[0]));
        text += (needsSpace ? ' ' : '') + it.str;
        prevRight = Math.max(prevRight, it.x + it.w);
      }
      const h = Math.max(...its.map((i) => i.h || 0)) || g.h;
      return { text: text.replace(/\s+/g, ' ').trim(), x: its[0].x, y: g.y, h, right: prevRight };
    })
    .filter((l) => l.text);
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function percentile(nums: number[], p: number): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

const normalizeRunning = (t: string) => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

/** Remove running headers/footers (text repeated at the top/bottom of many pages) and page numbers. */
export function stripRunningLines(pages: PdfLine[][]): PdfLine[][] {
  const counts = new Map<string, number>();
  for (const lines of pages) {
    const edge = new Set([...lines.slice(0, 2), ...lines.slice(-2)].map((l) => normalizeRunning(l.text)));
    for (const k of edge) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const threshold = Math.max(2, Math.ceil(pages.length * 0.3));
  const bodyH = median(pages.flat().map((l) => l.h)) || 10;
  return pages.map((lines) =>
    lines.filter((l, i) => {
      const atEdge = i < 2 || i >= lines.length - 2;
      if (!atEdge) return true;
      if (/^[\s\-–—]*(\d{1,4}|[ivxlcdm]{1,6})[\s\-–—]*$/i.test(l.text)) return false;
      // Repeated chapter titles in large type are headings, not running headers.
      if (l.h > bodyH * 1.15) return true;
      return pages.length < 3 || (counts.get(normalizeRunning(l.text)) ?? 0) < threshold;
    }),
  );
}

const SENTENCE_END = /[.!?…:;。！？」』"”»)]$/;

/** Join lines into paragraphs using spacing, indentation, line length and font size. */
export function linesToParagraphs(pages: PdfLine[][]): Paragraph[] {
  const all = pages.flatMap((lines, p) => lines.map((l) => ({ ...l, page: p + 1 })));
  if (!all.length) return [];
  const gaps: number[] = [];
  for (const lines of pages) for (let i = 1; i < lines.length; i++) gaps.push(lines[i - 1].y - lines[i].y);
  const lineGap = median(gaps.filter((g) => g > 0)) || 14;
  const bodyH = median(all.map((l) => l.h)) || 10;
  const left = median(all.map((l) => Math.round(l.x)));
  const fullWidth = percentile(all.map((l) => l.right), 0.9);
  const lineWidth = fullWidth - left || 1;

  const paras: Paragraph[] = [];
  let cur: (Paragraph & { lastShort?: boolean }) | null = null;
  let prev: (typeof all)[number] | null = null;
  for (const l of all) {
    const ratio = l.h / bodyH;
    const heading: 1 | 2 | undefined = ratio > 1.6 ? 1 : ratio > 1.25 ? 2 : undefined;
    const indented = l.x > left + bodyH * 0.8 && l.x < left + lineWidth * 0.3;
    const prevShort = !!prev && prev.right < left + lineWidth * 0.8;
    const samePage = !!prev && prev.page === l.page;
    const bigGap = samePage && prev!.y - l.y > lineGap * 1.45;
    const prevHeading = !!cur?.h;
    const startNew =
      !cur ||
      !!heading !== prevHeading ||
      (heading && prevHeading && cur.h !== heading) ||
      bigGap ||
      indented ||
      (prevShort && SENTENCE_END.test(prev!.text)) ||
      (!samePage && !!prev && prevShort);
    if (startNew) {
      cur = { t: l.text, p: l.page, ...(heading ? { h: heading } : {}) };
      paras.push(cur);
    } else if (cur) {
      const t: string = cur.t;
      if (/[A-Za-zÀ-ÿ]-$/.test(t) && /^[a-zà-ÿ]/.test(l.text)) cur.t = t.slice(0, -1) + l.text;
      else if (NO_SPACE_SCRIPT.test(t.slice(-1)) && NO_SPACE_SCRIPT.test(l.text[0])) cur.t = t + l.text;
      else cur.t = `${t} ${l.text}`;
    }
    prev = l;
  }
  return paras.map(({ t, h, p }) => ({ t, p, ...(h ? { h } : {}) }));
}
