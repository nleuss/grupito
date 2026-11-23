// EPUB (2 and 3) -> book: reads the package (OPF), spine order and table of contents.
import { strFromU8, unzipSync } from 'fflate';
import type { ParsedBook, Paragraph, Section } from './types';
import { capSections } from './text-utils';

const BINARY = /\.(png|jpe?g|gif|svg|webp|bmp|ttf|otf|woff2?|mp3|mp4|m4a|ogg|webm|pdf)$/i;

function parseXml(text: string): Document {
  let doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
  if (doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(text, 'text/html');
  return doc;
}

function resolvePath(base: string, href: string): string {
  const clean = href.split('#')[0];
  const url = new URL(clean, `http://epub/${base}`);
  return decodeURIComponent(url.pathname.slice(1));
}

const BLOCKS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE', 'DT', 'DD', 'FIGCAPTION', 'TD', 'TH']);
const SKIP = new Set(['SCRIPT', 'STYLE', 'NAV', 'HEAD', 'svg', 'SVG', 'RT', 'RP']);

export function htmlToParagraphs(root: Element): Paragraph[] {
  const out: Paragraph[] = [];
  const textOf = (el: Element): string => {
    let s = '';
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3) s += n.nodeValue ?? '';
      else if (n.nodeType === 1) {
        const e = n as Element;
        if (SKIP.has(e.tagName.toUpperCase())) continue;
        if (e.tagName.toUpperCase() === 'BR') s += ' ';
        else s += textOf(e);
      }
    }
    return s;
  };
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toUpperCase();
      if (SKIP.has(tag)) continue;
      const hasBlockChild = Array.from(child.children).some((c) => BLOCKS.has(c.tagName.toUpperCase()) || c.tagName.toUpperCase() === 'DIV' || c.tagName.toUpperCase() === 'SECTION');
      if ((BLOCKS.has(tag) || tag === 'DIV' || tag === 'SECTION') && !hasBlockChild) {
        const t = textOf(child).replace(/\u00ad/g, '').replace(/\s+/g, ' ').trim();
        if (!t) continue;
        const level = /^H[1-6]$/.test(tag) ? (Math.min(3, Number(tag[1])) as 1 | 2 | 3) : undefined;
        out.push(level ? { t, h: level } : { t });
      } else walk(child);
    }
  };
  walk(root);
  return out;
}

export function parseEpub(data: Uint8Array, fallbackTitle: string): ParsedBook {
  const files = unzipSync(data, { filter: (f) => !BINARY.test(f.name) });
  const get = (p: string) => files[p] ?? files[decodeURIComponent(p)];
  const container = get('META-INF/container.xml');
  if (!container) throw new Error('Not an EPUB file (META-INF/container.xml is missing).');
  const encryption = get('META-INF/encryption.xml');
  if (encryption && /EncryptedData/.test(strFromU8(encryption)) && !/fonts?\//i.test(strFromU8(encryption))) {
    throw new Error('This EPUB is protected with DRM and cannot be read.');
  }
  const opfPath = parseXml(strFromU8(container)).getElementsByTagNameNS('*', 'rootfile')[0]?.getAttribute('full-path') ?? '';
  const opfData = get(opfPath);
  if (!opfData) throw new Error('EPUB package file not found.');
  const opf = parseXml(strFromU8(opfData));
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const meta = (name: string) => opf.getElementsByTagNameNS('*', name)[0]?.textContent?.trim() || undefined;

  const manifest = new Map<string, { href: string; type: string; props: string }>();
  for (const item of Array.from(opf.getElementsByTagNameNS('*', 'item'))) {
    manifest.set(item.getAttribute('id') ?? '', { href: resolvePath(dir, item.getAttribute('href') ?? ''), type: item.getAttribute('media-type') ?? '', props: item.getAttribute('properties') ?? '' });
  }

  // Table of contents labels by file (EPUB 3 nav, else EPUB 2 NCX).
  const labels = new Map<string, string>();
  const nav = [...manifest.values()].find((m) => m.props.split(/\s+/).includes('nav'));
  if (nav && get(nav.href)) {
    const navDoc = parseXml(strFromU8(get(nav.href)));
    const navDir = nav.href.includes('/') ? nav.href.slice(0, nav.href.lastIndexOf('/') + 1) : '';
    for (const a of Array.from(navDoc.getElementsByTagName('a'))) {
      const href = a.getAttribute('href');
      const label = a.textContent?.replace(/\s+/g, ' ').trim();
      if (href && label) {
        const path = resolvePath(navDir, href);
        if (!labels.has(path)) labels.set(path, label);
      }
    }
  } else {
    const ncx = [...manifest.values()].find((m) => m.type === 'application/x-dtbncx+xml');
    if (ncx && get(ncx.href)) {
      const ncxDoc = parseXml(strFromU8(get(ncx.href)));
      const ncxDir = ncx.href.includes('/') ? ncx.href.slice(0, ncx.href.lastIndexOf('/') + 1) : '';
      for (const np of Array.from(ncxDoc.getElementsByTagNameNS('*', 'navPoint'))) {
        const label = np.getElementsByTagNameNS('*', 'text')[0]?.textContent?.trim();
        const src = np.getElementsByTagNameNS('*', 'content')[0]?.getAttribute('src');
        if (label && src) {
          const path = resolvePath(ncxDir, src);
          if (!labels.has(path)) labels.set(path, label);
        }
      }
    }
  }

  const sections: Section[] = [];
  for (const ref of Array.from(opf.getElementsByTagNameNS('*', 'itemref'))) {
    const item = manifest.get(ref.getAttribute('idref') ?? '');
    if (!item || !/html|xml/.test(item.type)) continue;
    const raw = get(item.href);
    if (!raw) continue;
    const doc = parseXml(strFromU8(raw));
    const body = doc.getElementsByTagName('body')[0] ?? doc.documentElement;
    const paragraphs = htmlToParagraphs(body);
    if (!paragraphs.length) continue;
    const title = labels.get(item.href) ?? paragraphs.find((p) => p.h)?.t ?? `${sections.length + 1}`;
    sections.push({ title: title.slice(0, 100), paragraphs });
  }
  if (!sections.length) throw new Error('No readable text found in this EPUB.');
  return { title: meta('title') ?? fallbackTitle, author: meta('creator'), lang: meta('language'), sections: capSections(sections) };
}
