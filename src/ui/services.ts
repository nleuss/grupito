// Services used by the subtitle controller. They run wherever the controller runs (content
// script or extension page) and delegate network work to the service worker.
import type { ExplainResult, LineAnalysis, LookupResult, Settings } from '../shared/types';
import { bg } from '../shared/messages';
import { baseLang } from '../shared/languages';
import { analyzeLocal } from '../text/tokenize';

export interface Services {
  translate(lines: string[], from: string, to: string, settings: Settings, title?: string, context?: string): Promise<string[]>;
  lookup(word: string, lemma: string | undefined, sentence: string, from: string, to: string): Promise<LookupResult>;
  explain(word: string, sentence: string, from: string, to: string): Promise<ExplainResult>;
  analyze(lines: string[], lang: string): Promise<LineAnalysis[]>;
  aiStatus(): Promise<{ claude: boolean; deepl: boolean; stt: boolean }>;
}

// ---- Chrome's on-device Translator API (Chrome 138+). Used first in "auto" mode when available.
interface BuiltinTranslator {
  translate(text: string): Promise<string>;
}
interface TranslatorStatic {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(o: { sourceLanguage: string; targetLanguage: string }): Promise<BuiltinTranslator>;
}
const builtinCache = new Map<string, Promise<BuiltinTranslator | null>>();

async function builtinTranslator(from: string, to: string): Promise<BuiltinTranslator | null> {
  const T = (globalThis as unknown as { Translator?: TranslatorStatic }).Translator;
  if (!T) return null;
  const opts = { sourceLanguage: baseLang(from), targetLanguage: baseLang(to) };
  const key = `${opts.sourceLanguage}>${opts.targetLanguage}`;
  let p = builtinCache.get(key);
  if (!p) {
    p = (async () => {
      try {
        const a = await T.availability(opts);
        if (a === 'unavailable') return null;
        // Downloading a model needs a user gesture; only proceed if ready or we have activation.
        if (a !== 'available' && !(navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive) return null;
        return await T.create(opts);
      } catch {
        return null;
      }
    })();
    builtinCache.set(key, p);
    p.then((t) => {
      if (!t) builtinCache.delete(key);
    });
  }
  return p;
}

export const runtimeServices: Services = {
  async translate(lines, from, to, settings, title, context) {
    const provider = settings.translationProvider;
    if (provider === 'auto' || provider === 'chrome') {
      const tr = await builtinTranslator(from, to);
      if (tr) {
        try {
          return await Promise.all(lines.map((l) => tr.translate(l)));
        } catch (e) {
          if (provider === 'chrome') throw e;
        }
      } else if (provider === 'chrome') {
        throw new Error("Chrome's built-in translator is not available for this language pair");
      }
    }
    return (await bg('translate', { lines, from, to, title, context })).translations;
  },
  lookup(word, lemma, sentence, from, to) {
    return bg('lookup', { word, lemma, sentence, from, to });
  },
  explain(word, sentence, from, to) {
    return bg('explain', { word, sentence, from, to });
  },
  async analyze(lines, lang) {
    const b = baseLang(lang);
    if (b === 'ja' || b === 'zh') {
      try {
        return (await bg('analyze', { lines, lang })).lines;
      } catch {
        /* fall back to local segmentation */
      }
    }
    return lines.map((l) => analyzeLocal(l, lang));
  },
  aiStatus() {
    return bg('ai:status', {});
  },
};
