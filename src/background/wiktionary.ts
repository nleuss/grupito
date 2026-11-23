// English Wiktionary REST definitions (covers words of most languages, glossed in English).
import type { Definition } from '../shared/types';
import { baseLang } from '../shared/languages';

interface WiktEntry {
  partOfSpeech?: string;
  language?: string;
  definitions?: { definition?: string; examples?: string[]; parsedExamples?: { example?: string }[] }[];
}

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseWiktionary(json: Record<string, WiktEntry[]>, lang: string): Definition[] {
  const entries = json?.[baseLang(lang)] ?? [];
  const out: Definition[] = [];
  for (const e of entries) {
    for (const d of e.definitions ?? []) {
      const text = stripHtml(d.definition ?? '');
      if (!text) continue;
      const ex = d.parsedExamples?.[0]?.example ?? d.examples?.[0];
      out.push({ pos: e.partOfSpeech?.toLowerCase(), text, example: ex ? stripHtml(ex) : undefined });
    }
  }
  return out;
}

export async function wiktionaryLookup(word: string, lang: string): Promise<Definition[]> {
  for (const w of [word, word.toLowerCase()].filter((x, i, a) => a.indexOf(x) === i)) {
    const res = await fetch(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(w)}`, { credentials: 'omit' });
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`Wiktionary HTTP ${res.status}`);
    const defs = parseWiktionary(await res.json(), lang);
    if (defs.length) return defs;
  }
  return [];
}
