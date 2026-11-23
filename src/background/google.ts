// Google Translate's free "gtx" endpoint (unofficial; may rate-limit) — request + response parsing.
import type { DictEntry, Definition } from '../shared/types';
import { googleCode } from '../shared/languages';
import { mapLimit } from '../shared/util';

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

type GtxResponse = unknown[];

async function gtx(text: string, from: string, to: string, dts: string[]): Promise<GtxResponse> {
  const params = new URLSearchParams({ client: 'gtx', sl: from ? googleCode(from) : 'auto', tl: googleCode(to), hl: googleCode(to) });
  for (const d of dts) params.append('dt', d);
  const q = new URLSearchParams({ q: text }).toString();
  // GET like the official clients for normal batches; POST keeps very long (e.g. CJK) batches out of the URL.
  const res =
    q.length < 6000
      ? await fetch(`${ENDPOINT}?${params}&${q}`, { credentials: 'omit' })
      : await fetch(`${ENDPOINT}?${params}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: q,
          credentials: 'omit',
        });
  if (res.status === 429) throw new Error('Google Translate rate limit (HTTP 429). Try again later or choose another provider.');
  if (!res.ok) throw new Error(`Google Translate HTTP ${res.status}`);
  return (await res.json()) as GtxResponse;
}

/** Concatenated translation of a gtx response (sentences are split by Google). */
export function parseGoogleTranslation(data: GtxResponse): string {
  const sentences = Array.isArray(data?.[0]) ? (data[0] as unknown[][]) : [];
  return sentences.map((s) => (Array.isArray(s) && typeof s[0] === 'string' ? s[0] : '')).join('');
}

/** Source-text transliteration (romaji, pinyin…) when Google returns one. */
export function parseGoogleTransliteration(data: GtxResponse): string | undefined {
  const sentences = Array.isArray(data?.[0]) ? (data[0] as unknown[][]) : [];
  const parts = sentences.filter((s) => Array.isArray(s) && s[0] == null && typeof s[3] === 'string').map((s) => s[3] as string);
  return parts.length ? parts.join(' ') : undefined;
}

export function parseGoogleDict(data: GtxResponse): { entries: DictEntry[]; definitions: Definition[]; lemma?: string } {
  const entries: DictEntry[] = [];
  const definitions: Definition[] = [];
  let lemma: string | undefined;
  const bd = data?.[1];
  if (Array.isArray(bd)) {
    for (const e of bd) {
      if (!Array.isArray(e)) continue;
      const pos = typeof e[0] === 'string' ? e[0] : '';
      const terms = Array.isArray(e[1]) ? (e[1] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
      if (typeof e[3] === 'string' && !lemma) lemma = e[3];
      if (terms.length) entries.push({ pos, terms });
    }
  }
  const md = data?.[12];
  if (Array.isArray(md)) {
    for (const e of md) {
      if (!Array.isArray(e)) continue;
      const pos = typeof e[0] === 'string' ? e[0] : undefined;
      const defs = Array.isArray(e[1]) ? (e[1] as unknown[][]) : [];
      for (const d of defs) {
        if (Array.isArray(d) && typeof d[0] === 'string') definitions.push({ pos, text: d[0], example: typeof d[2] === 'string' ? d[2] : undefined });
      }
      if (typeof e[2] === 'string' && !lemma) lemma = e[2];
    }
  }
  return { entries, definitions, lemma };
}

/** Translate many lines. Lines are joined with newlines (one request) and split back. */
export async function googleTranslate(lines: string[], from: string, to: string): Promise<string[]> {
  const out: string[] = [];
  // Keep requests modest; CJK text is dense.
  const batches: string[][] = [];
  let cur: string[] = [];
  let len = 0;
  for (const l of lines) {
    const clean = l.replace(/\n/g, ' ');
    if (cur.length && (len + clean.length > 1800 || cur.length >= 40)) {
      batches.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(clean);
    len += clean.length + 1;
  }
  if (cur.length) batches.push(cur);
  for (const batch of batches) {
    const data = await gtx(batch.join('\n'), from, to, ['t']);
    const parts = parseGoogleTranslation(data).split('\n');
    if (parts.length === batch.length) out.push(...parts.map((p) => p.trim()));
    else {
      // Google merged or split lines: translate this batch line by line instead.
      out.push(...(await mapLimit(batch, 3, async (l) => parseGoogleTranslation(await gtx(l, from, to, ['t'])).trim())));
    }
  }
  return out;
}

export async function googleLookup(word: string, from: string, to: string) {
  const data = await gtx(word, from, to, ['t', 'bd', 'md', 'rm', 'ex', 'ss']);
  return { translation: parseGoogleTranslation(data).trim(), romanization: parseGoogleTransliteration(data), ...parseGoogleDict(data) };
}
