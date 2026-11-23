// Japanese morphological analysis with kuromoji (IPADIC): tokens, lemmas, furigana and romaji.
// Runs in the offscreen document; the dictionary (~18 MB gz) is bundled with the extension.
import kuromoji from 'kuromoji';
import BrowserDictionaryLoader from 'kuromoji/src/loader/BrowserDictionaryLoader';
import { toHiragana, toRomaji } from 'wanakana';
import type { LineAnalysis, RubyPart, Token } from '../shared/types';

interface KToken {
  surface_form: string;
  pos: string;
  basic_form: string;
  reading?: string;
  pronunciation?: string;
}
interface KTokenizer {
  tokenize(text: string): KToken[];
}

// Use fetch + native gzip decompression instead of kuromoji's XHR + JS gunzip.
(BrowserDictionaryLoader as unknown as { prototype: { loadArrayBuffer: (url: string, cb: (e: unknown, b: ArrayBuffer | null) => void) => void } }).prototype.loadArrayBuffer =
  function (url, cb) {
    fetch(url)
      .then(async (r) => {
        if (!r.ok || !r.body) throw new Error(`HTTP ${r.status} for ${url}`);
        return new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      })
      .then(
        (buf) => cb(null, buf),
        (err) => cb(err, null),
      );
  };

let tokenizer: Promise<KTokenizer> | null = null;

export function getTokenizer(dicPath: string): Promise<KTokenizer> {
  if (!tokenizer) {
    tokenizer = new Promise((resolve, reject) => {
      kuromoji.builder({ dicPath }).build((err: unknown, t: KTokenizer) => (err ? reject(err) : resolve(t)));
    });
    tokenizer.catch(() => (tokenizer = null));
  }
  return tokenizer;
}

const KANJI = /[㐀-䶿一-鿿豈-﫿々〆ヵヶ]/;

export function hasKanji(s: string): boolean {
  return KANJI.test(s);
}

/** Split a reading over the kanji runs of a word: 食べる/たべる -> 食(た)べる. */
export function alignFurigana(surface: string, reading: string): RubyPart[] {
  const runs: { text: string; kanji: boolean }[] = [];
  for (const ch of surface) {
    const k = KANJI.test(ch);
    const last = runs[runs.length - 1];
    if (last && last.kanji === k) last.text += ch;
    else runs.push({ text: ch, kanji: k });
  }
  if (!runs.some((r) => r.kanji)) return [{ base: surface }];
  if (runs.length === 1) return [{ base: surface, rt: reading }];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + runs.map((r) => (r.kanji ? '(.+?)' : esc(toHiragana(r.text)))).join('') + '$');
  const m = reading.match(re);
  if (!m) return [{ base: surface, rt: reading }];
  let g = 1;
  return runs.map((r) => (r.kanji ? { base: r.text, rt: m[g++] } : { base: r.text }));
}

export function analyzeJapaneseWith(tk: KTokenizer, line: string): LineAnalysis {
  const tokens: Token[] = [];
  const roman: string[] = [];
  for (const k of tk.tokenize(line)) {
    const surface = k.surface_form;
    const isSymbol = k.pos === '記号' || !/[\p{L}\p{N}]/u.test(surface);
    const reading = k.reading && k.reading !== '*' ? toHiragana(k.reading) : undefined;
    // Particles are pronounced differently from how they are written (は→wa, へ→e, を→o).
    const sound = k.pos === '助詞' && k.pronunciation && k.pronunciation !== '*' ? k.pronunciation : (k.reading && k.reading !== '*' ? k.reading : surface);
    const r = isSymbol ? undefined : k.pos === '助詞' && surface === 'を' ? 'o' : toRomaji(sound);
    const kanji = hasKanji(surface);
    tokens.push({
      text: surface,
      word: !isSymbol,
      lemma: k.basic_form && k.basic_form !== '*' ? k.basic_form : surface,
      reading: kanji ? reading : undefined,
      ruby: kanji && reading ? alignFurigana(surface, reading) : undefined,
      roman: r,
    });
    if (r) roman.push(r);
    else if (/[。、！？!?,.]/.test(surface)) {
      const p = surface.replace('。', '.').replace('、', ',').replace('！', '!').replace('？', '?');
      if (roman.length) roman[roman.length - 1] += p;
    }
  }
  return { tokens, roman: roman.join(' ') };
}

export async function analyzeJapanese(lines: string[], dicPath: string): Promise<LineAnalysis[]> {
  const tk = await getTokenizer(dicPath);
  return lines.map((l) => analyzeJapaneseWith(tk, l));
}
