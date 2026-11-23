// Word segmentation with Intl.Segmenter (handles CJK/Thai dictionaries via ICU).
import type { LineAnalysis, Token } from '../shared/types';
import { baseLang } from '../shared/languages';
import { romanizeLine } from './romanize';

const segmenters = new Map<string, Intl.Segmenter>();

function segmenter(lang: string): Intl.Segmenter {
  const key = baseLang(lang) || 'en';
  let s = segmenters.get(key);
  if (!s) {
    try {
      s = new Intl.Segmenter(key, { granularity: 'word' });
    } catch {
      s = new Intl.Segmenter('en', { granularity: 'word' });
    }
    segmenters.set(key, s);
  }
  return s;
}

const LETTER = /\p{L}/u;

export function tokenize(text: string, lang: string): Token[] {
  const tokens: Token[] = [];
  for (const seg of segmenter(lang).segment(text)) {
    tokens.push({ text: seg.segment, word: !!seg.isWordLike && LETTER.test(seg.segment) });
  }
  return tokens;
}

/** Local (synchronous) analysis: tokens + romanized line for languages we can transliterate offline. */
export function analyzeLocal(text: string, lang: string): LineAnalysis {
  const tokens = tokenize(text, lang);
  const roman = romanizeLine(text, lang);
  return roman ? { tokens, roman } : { tokens };
}
