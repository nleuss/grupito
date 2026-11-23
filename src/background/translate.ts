// Translation providers with a persistent cache.
import type { Secrets, Settings } from '../shared/types';
import { deeplCode } from '../shared/languages';
import { cacheGetMany, cacheSetMany } from './cache';
import { googleTranslate } from './google';
import { translateLines as claudeTranslate } from './claude';

export async function deeplTranslate(key: string, lines: string[], from: string, to: string): Promise<string[]> {
  const host = key.trim().endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 50) {
    const chunk = lines.slice(i, i + 50);
    const res = await fetch(`${host}/v2/translate`, {
      method: 'POST',
      headers: { Authorization: `DeepL-Auth-Key ${key.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: chunk, source_lang: deeplCode(from, false), target_lang: deeplCode(to, true), split_sentences: '0' }),
    });
    if (res.status === 403) throw new Error('Invalid DeepL API key');
    if (res.status === 456) throw new Error('DeepL quota exceeded');
    if (!res.ok) throw new Error(`DeepL HTTP ${res.status}`);
    const data = (await res.json()) as { translations?: { text: string }[] };
    out.push(...chunk.map((_, k) => data.translations?.[k]?.text ?? ''));
  }
  return out;
}

/** Deterministic fake translation used by the test build. */
function mockTranslate(lines: string[], to: string): string[] {
  return lines.map((l) => `[${to}] ${l}`);
}

function resolveProvider(settings: Settings, secrets: Secrets): 'google' | 'deepl' | 'claude' | 'mock' {
  const p = settings.translationProvider;
  if (p === 'mock' && __TEST__) return 'mock';
  if (p === 'deepl' && secrets.deeplKey) return 'deepl';
  if (p === 'claude' && secrets.claudeKey) return 'claude';
  if (p === 'deepl' || p === 'claude') throw new Error(`Add your ${p === 'deepl' ? 'DeepL' : 'Claude'} API key in Settings`);
  return 'google';
}

export async function translate(
  lines: string[],
  from: string,
  to: string,
  settings: Settings,
  secrets: Secrets,
  title?: string,
): Promise<{ translations: string[]; provider: string }> {
  const provider = resolveProvider(settings, secrets);
  const tag = provider === 'claude' ? `claude:${settings.claudeModel}` : provider;
  const keys = lines.map((l) => `tr|${tag}|${from}|${to}|${l}`);
  const cached = await cacheGetMany<string>(keys);
  const missing = lines.map((l, i) => (cached[i] === undefined ? i : -1)).filter((i) => i >= 0);
  if (missing.length) {
    const src = missing.map((i) => lines[i]);
    let res: string[];
    switch (provider) {
      case 'mock':
        res = mockTranslate(src, to);
        break;
      case 'deepl':
        res = await deeplTranslate(secrets.deeplKey, src, from, to);
        break;
      case 'claude':
        res = await claudeTranslate(secrets.claudeKey, settings.claudeModel, src, from, to, title);
        break;
      default:
        res = await googleTranslate(src, from, to);
    }
    const entries: [string, unknown][] = [];
    missing.forEach((i, k) => {
      cached[i] = res[k] ?? '';
      if (res[k]) entries.push([keys[i], res[k]]);
    });
    await cacheSetMany(entries);
  }
  return { translations: cached.map((c) => c ?? ''), provider };
}
