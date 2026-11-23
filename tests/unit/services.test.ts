import { describe, expect, it } from 'vitest';
import { parseGoogleDict, parseGoogleTranslation, parseGoogleTransliteration } from '../../src/background/google';
import { parseWiktionary } from '../../src/background/wiktionary';
import { Chunker, encodeWav, type AudioChunk } from '../../src/ai/audio';
import { TimeMap } from '../../src/ui/timemap';
import { alignFurigana, analyzeJapanese } from '../../src/text/japanese';
import { analyzeChinese } from '../../src/text/chinese';

describe('Google gtx parsing', () => {
  // Shape of translate_a/single?client=gtx&dt=t&dt=bd&dt=md&dt=rm for "house" en->es
  const sample = [
    [
      ['casa', 'house', null, null, 10],
      [null, null, 'kasa', 'haus'],
    ],
    [
      ['sustantivo', ['casa', 'hogar', 'vivienda'], [['casa', ['house', 'home'], null, 0.62]], 'house', 1],
      ['verbo', ['alojar', 'albergar'], [['alojar', ['house', 'lodge'], null, 0.02]], 'house', 2],
    ],
    'en',
    null,
    null,
    null,
    1,
    [],
    [['en'], null, [1], ['en']],
    null,
    null,
    null,
    [
      ['noun', [['A building for human habitation.', 'm_en_1', 'the house was built in 1856']], 'house', 1],
      ['verb', [['Provide with shelter or accommodation.', 'm_en_2']], 'house', 2],
    ],
  ];
  it('extracts translation, transliteration, dictionary entries and definitions', () => {
    expect(parseGoogleTranslation(sample)).toBe('casa');
    expect(parseGoogleTransliteration(sample)).toBe('haus');
    const d = parseGoogleDict(sample);
    expect(d.entries).toEqual([
      { pos: 'sustantivo', terms: ['casa', 'hogar', 'vivienda'] },
      { pos: 'verbo', terms: ['alojar', 'albergar'] },
    ]);
    expect(d.definitions[0]).toEqual({ pos: 'noun', text: 'A building for human habitation.', example: 'the house was built in 1856' });
    expect(d.lemma).toBe('house');
  });
  it('tolerates empty or odd responses', () => {
    expect(parseGoogleTranslation([])).toBe('');
    expect(parseGoogleDict([null, 'x'])).toEqual({ entries: [], definitions: [], lemma: undefined });
  });
  it('joins multi-sentence translations', () => {
    expect(parseGoogleTranslation([[['Hola. ', 'Hi. '], ['¿Qué tal?\n', 'How are you?\n'], ['Bien', 'Fine']]])).toBe('Hola. ¿Qué tal?\nBien');
  });
});

describe('Wiktionary parsing', () => {
  it('picks the right language and strips HTML', () => {
    const json = {
      es: [
        {
          partOfSpeech: 'Noun',
          language: 'Spanish',
          definitions: [
            { definition: '<a href="/wiki/house">house</a>, <b>home</b>', parsedExamples: [{ example: 'Mi <b>casa</b> es tu casa.' }] },
            { definition: '' },
          ],
        },
      ],
      it: [{ partOfSpeech: 'Noun', definitions: [{ definition: 'house (Italian)' }] }],
    };
    expect(parseWiktionary(json, 'es-419')).toEqual([{ pos: 'noun', text: 'house, home', example: 'Mi casa es tu casa.' }]);
    expect(parseWiktionary(json, 'fr')).toEqual([]);
  });
});

describe('audio chunking', () => {
  const rate = 16000;
  const tone = (sec: number) => Float32Array.from({ length: sec * rate }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / rate));
  const silence = (sec: number) => new Float32Array(sec * rate);

  it('cuts at pauses after the minimum length and flags silent chunks', () => {
    const chunks: AudioChunk[] = [];
    const ch = new Chunker({ sampleRate: rate, minSec: 2, maxSec: 10, silenceRms: 0.01, silenceMs: 300 }, (c) => chunks.push(c), 1 / rate);
    const parts = [tone(3), silence(1), tone(2.5), silence(1), silence(2)];
    let t = 0;
    for (const p of parts) {
      // feed in 4096-sample batches like the worklet does
      for (let i = 0; i < p.length; i += 4096) ch.push(p.subarray(i, i + 4096), t + i / rate);
      t += p.length / rate;
    }
    ch.flush();
    const voiced = chunks.filter((c) => !c.silent);
    expect(voiced.length).toBe(2);
    expect(voiced[0].start).toBeCloseTo(0, 3);
    expect(voiced[0].samples.length / rate).toBeGreaterThan(3);
    expect(voiced[0].samples.length / rate).toBeLessThan(3.5);
    expect(voiced[1].start).toBeGreaterThan(3);
    expect(voiced[1].start).toBeLessThan(4.1);
  });

  it('forces a cut at maxSec without pauses', () => {
    const chunks: AudioChunk[] = [];
    const ch = new Chunker({ sampleRate: rate, minSec: 2, maxSec: 5, silenceRms: 0.01, silenceMs: 300 }, (c) => chunks.push(c), 1 / rate);
    const p = tone(12);
    for (let i = 0; i < p.length; i += 4096) ch.push(p.subarray(i, i + 4096), i / rate);
    expect(chunks.length).toBe(2);
    expect(chunks.every((c) => c.samples.length <= 5.3 * rate)).toBe(true);
  });

  it('writes a valid WAV header', async () => {
    const wav = encodeWav(new Float32Array(160), rate);
    const buf = new DataView(await wav.arrayBuffer());
    expect(wav.size).toBe(44 + 320);
    expect(String.fromCharCode(buf.getUint8(0), buf.getUint8(1), buf.getUint8(2), buf.getUint8(3))).toBe('RIFF');
    expect(buf.getUint32(24, true)).toBe(rate);
  });
});

describe('TimeMap', () => {
  it('maps wall clock to media time across pauses', () => {
    const tm = new TimeMap();
    tm.push({ wall: 1000, media: 10, playing: true, rate: 1 });
    tm.push({ wall: 3000, media: 12, playing: false, rate: 1 });
    tm.push({ wall: 8000, media: 12, playing: true, rate: 2 });
    expect(tm.toMedia(2000)).toBeCloseTo(11);
    expect(tm.toMedia(5000)).toBeCloseTo(12);
    expect(tm.toMedia(9000)).toBeCloseTo(14);
    expect(tm.toMedia(500)).toBeNull();
  });
});

describe('Japanese', () => {
  it('aligns furigana over kanji runs', () => {
    expect(alignFurigana('食べる', 'たべる')).toEqual([{ base: '食', rt: 'た' }, { base: 'べる' }]);
    expect(alignFurigana('お茶', 'おちゃ')).toEqual([{ base: 'お' }, { base: '茶', rt: 'ちゃ' }]);
    expect(alignFurigana('日本語', 'にほんご')).toEqual([{ base: '日本語', rt: 'にほんご' }]);
    expect(alignFurigana('ひらがな', 'ひらがな')).toEqual([{ base: 'ひらがな' }]);
  });

  it('analyzes a sentence with kuromoji (lemmas, readings, romaji)', async () => {
    const [a] = await analyzeJapanese(['私は日本語を勉強しています。'], 'node_modules/kuromoji/dict/');
    const words = a.tokens.filter((t) => t.word);
    expect(words.map((w) => w.text)).toEqual(['私', 'は', '日本語', 'を', '勉強', 'し', 'て', 'い', 'ます']);
    expect(words.find((w) => w.text === 'し')?.lemma).toBe('する');
    expect(words[0].ruby).toEqual([{ base: '私', rt: 'わたし' }]);
    expect(a.roman).toBe('watashi wa nihongo o benkyou shi te i masu.');
  });
});

describe('Chinese', () => {
  it('adds per-character pinyin to segmented words', () => {
    const a = analyzeChinese('我喜欢学习中文。');
    const words = a.tokens.filter((t) => t.word);
    expect(words.map((w) => w.text)).toEqual(['我', '喜欢', '学习', '中文']);
    expect(words[1].ruby).toEqual([
      { base: '喜', rt: 'xǐ' },
      { base: '欢', rt: 'huan' },
    ]);
    expect(a.roman).toBe('wǒ xǐhuan xuéxí zhōngwén。');
  });
});
