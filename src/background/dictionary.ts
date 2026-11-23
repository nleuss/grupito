// Word lookup: Google's dictionary data (translations by part of speech) + Wiktionary definitions.
import type { LookupResult, Secrets, Settings } from '../shared/types';
import { cacheGet, cacheSet } from './cache';
import { googleLookup } from './google';
import { wiktionaryLookup } from './wiktionary';
import { translate } from './translate';
import { errorMessage } from '../shared/util';

function mockLookup(word: string, to: string): LookupResult {
  return {
    word,
    translation: `[${to}] ${word}`,
    entries: [{ pos: 'noun', terms: [`${word}-1`, `${word}-2`] }],
    definitions: [{ pos: 'noun', text: `Definition of ${word}`, example: `An example with ${word}.` }],
    sources: ['mock'],
  };
}

export async function lookup(
  req: { word: string; lemma?: string; sentence: string; from: string; to: string },
  settings: Settings,
  secrets: Secrets,
): Promise<LookupResult> {
  const { word, lemma, from, to } = req;
  if (__TEST__ && settings.translationProvider === 'mock') return mockLookup(word, to);
  const key = `lk|${from}|${to}|${word}`;
  const cached = await cacheGet<LookupResult>(key);
  if (cached) return cached;

  const result: LookupResult = { word, lemma, entries: [], definitions: [], sources: [] };
  const errors: string[] = [];
  const [g, w] = await Promise.allSettled([googleLookup(word, from, to), wiktionaryLookup(lemma ?? word, from)]);
  if (g.status === 'fulfilled') {
    result.translation = g.value.translation || undefined;
    result.entries = g.value.entries;
    result.definitions = g.value.definitions;
    result.romanization = g.value.romanization;
    if (!result.lemma && g.value.lemma && g.value.lemma.toLowerCase() !== word.toLowerCase()) result.lemma = g.value.lemma;
    result.sources.push('Google');
  } else errors.push(errorMessage(g.reason));
  if (w.status === 'fulfilled' && w.value.length) {
    // Wiktionary glosses are in English: show them after Google's own definitions.
    result.definitions = [...result.definitions, ...w.value].slice(0, 8);
    result.sources.push('Wiktionary');
  } else if (w.status === 'rejected') errors.push(errorMessage(w.reason));

  // Last resort: translate the word with the configured provider (DeepL / Claude).
  if (!result.translation && !result.entries.length) {
    try {
      const tr = await translate([word], from, to, settings, secrets);
      result.translation = tr.translations[0] || undefined;
      if (result.translation) result.sources.push(tr.provider);
    } catch (e) {
      errors.push(errorMessage(e));
    }
  }
  if (!result.translation && !result.entries.length && !result.definitions.length && errors.length) throw new Error(errors[0]);
  if (result.translation || result.entries.length || result.definitions.length) await cacheSet(key, result);
  return result;
}
