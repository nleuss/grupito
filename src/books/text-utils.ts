// Text helpers for the reader: sentences, passages, chapter detection, token estimates.
import type { Paragraph, ParsedBook, Section } from './types';
import { baseLang } from '../shared/languages';

const sentenceSegmenters = new Map<string, Intl.Segmenter>();

export function sentences(text: string, lang: string): { text: string; start: number; end: number }[] {
  const key = baseLang(lang) || 'en';
  let seg = sentenceSegmenters.get(key);
  if (!seg) {
    seg = new Intl.Segmenter(key, { granularity: 'sentence' });
    sentenceSegmenters.set(key, seg);
  }
  return [...seg.segment(text)].map((s) => ({ text: s.segment.trim(), start: s.index, end: s.index + s.segment.length })).filter((s) => s.text);
}

/** The sentence of `text` that contains character offset `at`. */
export function sentenceAt(text: string, at: number, lang: string): string {
  const all = sentences(text, lang);
  return (all.find((s) => at >= s.start && at < s.end) ?? all[all.length - 1])?.text ?? text;
}

/** A passage around paragraph `i` (previous + current + next), trimmed to `max` characters. */
export function passageAround(paragraphs: Paragraph[], i: number, max = 2400): string {
  const cur = paragraphs[i]?.t ?? '';
  let out = cur;
  const prev = paragraphs[i - 1]?.t;
  const next = paragraphs[i + 1]?.t;
  if (prev && out.length + prev.length < max) out = `${prev}\n\n${out}`;
  if (next && out.length + next.length < max) out = `${out}\n\n${next}`;
  return out.length > max ? out.slice(0, max) : out;
}

const CJK = /[぀-ヿ㐀-鿿가-힯]/g;

/** Rough token estimate (Claude tokenizer): ~4 chars/token for Latin text, ~1.3 for CJK. */
export function estimateTokens(text: string): number {
  const cjk = (text.match(CJK) ?? []).length;
  return Math.ceil(cjk / 1.3 + (text.length - cjk) / 3.6);
}

export function bookText(sections: Section[]): string {
  return sections.map((s) => `## ${s.title}\n\n${s.paragraphs.map((p) => p.t).join('\n\n')}`).join('\n\n');
}

const CHAPTER = /^(chapter|cap[ií]tulo|chapitre|kapitel|capitolo|cap[ií]tol|part|parte|libro|book|prologue|pr[oó]logo|epilogue|ep[ií]logo)\b[\s.:]*([\divxlc]+|[a-zà-ú]+)?\b.{0,60}$|^第[一二三四五六七八九十百千\d]+[章回節话]/i;

export function looksLikeChapterTitle(line: string): boolean {
  return line.length <= 80 && CHAPTER.test(line.trim());
}

/** Plain text (TXT/Markdown) -> sections split on chapter-like headings. */
export function parsePlainText(text: string, title: string): ParsedBook {
  const blocks = text
    .replace(/\u00ad/g, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  // Files without blank lines: one paragraph per line.
  const paras = blocks.length <= 2 && text.split('\n').length > 20 ? text.split('\n').map((l) => l.trim()).filter(Boolean) : blocks;
  const sections: Section[] = [];
  let cur: Section = { title, paragraphs: [] };
  for (const raw of paras) {
    const md = raw.match(/^(#{1,3})\s+(.+)$/);
    const line = raw.replace(/\s*\n\s*/g, ' ');
    if (md || looksLikeChapterTitle(line)) {
      if (cur.paragraphs.length) sections.push(cur);
      const heading = md ? md[2] : line;
      cur = { title: heading, paragraphs: [{ t: heading, h: 1 }] };
    } else cur.paragraphs.push({ t: line });
  }
  if (cur.paragraphs.length) sections.push(cur);
  return { title, sections: sections.length ? sections : [{ title, paragraphs: [] }] };
}

/** Split very long sections so the reader never renders a huge chapter at once. */
export function capSections(sections: Section[], maxParagraphs = 220): Section[] {
  const out: Section[] = [];
  for (const s of sections) {
    if (s.paragraphs.length <= maxParagraphs) {
      out.push(s);
      continue;
    }
    for (let i = 0, part = 1; i < s.paragraphs.length; i += maxParagraphs, part++) {
      out.push({ title: `${s.title} (${part})`, paragraphs: s.paragraphs.slice(i, i + maxParagraphs) });
    }
  }
  return out;
}
