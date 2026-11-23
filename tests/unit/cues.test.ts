import { describe, expect, it } from 'vitest';
import { activeCueIndices, alignCues, mergeFragments, normalizeCues, toSrt } from '../../src/subtitles/cues';
import { isHlsMaster, parseHlsMaster, parseHlsMedia } from '../../src/subtitles/hls';
import { romanizeKorean, romanizeLine } from '../../src/text/romanize';
import { tokenize } from '../../src/text/tokenize';
import type { Cue } from '../../src/shared/types';

describe('normalizeCues', () => {
  it('sorts, merges HLS duplicates and same-time fragments', () => {
    const cues: Cue[] = [
      { start: 5, end: 6, text: 'b' },
      { start: 1, end: 2, text: 'a' },
      { start: 1.9, end: 3, text: 'a' },
      { start: 5, end: 6, text: 'c' },
      { start: 7, end: 7, text: 'zero length' },
    ];
    expect(normalizeCues(cues)).toEqual([
      { start: 1, end: 3, text: 'a' },
      { start: 5, end: 6, text: 'b\nc' },
    ]);
  });
  it('trims rolling-caption overlaps', () => {
    const cues = normalizeCues(
      [
        { start: 0, end: 4, text: 'one' },
        { start: 2, end: 6, text: 'two' },
      ],
      { trimOverlaps: true },
    );
    expect(cues[0].end).toBe(2);
  });
});

describe('mergeFragments (YouTube auto-captions)', () => {
  it('joins fragments until sentence punctuation, length or duration limits', () => {
    const frags: Cue[] = [
      { start: 1, end: 2.2, text: 'Hello there, how' },
      { start: 2.2, end: 3.5, text: 'are you today?' },
      { start: 3.8, end: 5, text: 'so today we are' },
      { start: 5, end: 6, text: 'going to talk about' },
      { start: 6, end: 7.2, text: 'the weather and' },
      { start: 7.2, end: 8.5, text: 'many other things' },
      { start: 10, end: 11, text: 'after a pause' },
    ];
    expect(mergeFragments(frags, 'en').map((c) => [c.start, c.end, c.text])).toEqual([
      [1, 3.5, 'Hello there, how are you today?'],
      [3.8, 8.5, 'so today we are going to talk about the weather and many other things'],
      [10, 11, 'after a pause'],
    ]);
  });
  it('caps long unpunctuated runs and joins CJK without spaces', () => {
    const run: Cue[] = Array.from({ length: 12 }, (_, i) => ({ start: i, end: i + 1, text: 'word word word' }));
    const merged = mergeFragments(run, 'en');
    expect(merged.every((c) => c.end - c.start <= 7 && c.text.length <= 90)).toBe(true);
    expect(merged.length).toBeGreaterThan(1);
    expect(mergeFragments([{ start: 0, end: 1, text: '今日は' }, { start: 1, end: 2, text: 'いい天気' }], 'ja')[0].text).toBe('今日はいい天気');
  });
});

describe('activeCueIndices', () => {
  const cues: Cue[] = [
    { start: 0, end: 10, text: 'long' },
    { start: 2, end: 3, text: 'x' },
    { start: 4, end: 5, text: 'y' },
  ];
  it('finds overlapping active cues', () => {
    expect(activeCueIndices(cues, 2.5)).toEqual([0, 1]);
    expect(activeCueIndices(cues, 3.5)).toEqual([0]);
    expect(activeCueIndices(cues, 11)).toEqual([]);
    expect(activeCueIndices([], 1)).toEqual([]);
  });
});

describe('alignCues', () => {
  it('handles 1:N and N:1 timing differences', () => {
    const primary: Cue[] = [
      { start: 0, end: 4, text: 'Hello, how are you today?' },
      { start: 5, end: 6, text: 'Fine.' },
      { start: 6, end: 7, text: 'Thanks.' },
    ];
    const secondary: Cue[] = [
      { start: 0, end: 2, text: 'Hola,' },
      { start: 2, end: 4, text: '¿cómo estás hoy?' },
      { start: 5, end: 7, text: 'Bien, gracias.' },
    ];
    expect(alignCues(primary, secondary)).toEqual(['Hola,\n¿cómo estás hoy?', 'Bien, gracias.', 'Bien, gracias.']);
  });
});

describe('export', () => {
  it('writes dual SRT', () => {
    expect(toSrt([{ start: 1.5, end: 2, text: 'Hi' }], ['Hola'])).toBe('1\n00:00:01,500 --> 00:00:02,000\nHi\nHola\n');
  });
});

describe('HLS', () => {
  const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="en",NAME="English",URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub-main",NAME="English",LANGUAGE="en",AUTOSELECT=YES,DEFAULT=YES,URI="subs/en/index.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub-main",NAME="Español [CC]",LANGUAGE="es-419",CHARACTERISTICS="public.accessibility.transcribes-spoken-dialog",URI="subs/es/index.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub-forced",NAME="English",LANGUAGE="en",FORCED=YES,URI="subs/en-forced/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,SUBTITLES="sub-main"
video/1.m3u8`;
  it('lists subtitle renditions with absolute URLs', () => {
    expect(isHlsMaster(master)).toBe(true);
    const r = parseHlsMaster(master, 'https://cdn.example.com/a/b/master.m3u8');
    expect(r.map((x) => [x.lang, x.forced, x.uri])).toEqual([
      ['en', false, 'https://cdn.example.com/a/b/subs/en/index.m3u8'],
      ['es-419', false, 'https://cdn.example.com/a/b/subs/es/index.m3u8'],
      ['en', true, 'https://cdn.example.com/a/b/subs/en-forced/index.m3u8'],
    ]);
  });
  it('lists media playlist segments', () => {
    const media = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg1.vtt\n#EXTINF:6.0,\n/abs/seg2.vtt\n#EXT-X-ENDLIST';
    expect(parseHlsMedia(media, 'https://cdn.example.com/subs/en/index.m3u8')).toEqual([
      'https://cdn.example.com/subs/en/seg1.vtt',
      'https://cdn.example.com/abs/seg2.vtt',
    ]);
  });
});

describe('text', () => {
  it('segments CJK and flags words', () => {
    const t = tokenize('我喜欢学习中文。', 'zh');
    expect(t.filter((x) => x.word).map((x) => x.text)).toEqual(['我', '喜欢', '学习', '中文']);
    const en = tokenize("Don't stop, 2024!", 'en');
    expect(en.filter((x) => x.word).map((x) => x.text)).toEqual(["Don't", 'stop']);
  });
  it('romanizes Korean with liaison', () => {
    expect(romanizeKorean('한국어')).toBe('hangugeo');
    expect(romanizeKorean('감사합니다')).toBe('gamsahapnida');
    expect(romanizeKorean('안녕하세요!')).toBe('annyeonghaseyo!');
  });
  it('romanizes Cyrillic and Greek preserving case', () => {
    expect(romanizeLine('Привет, мир', 'ru')).toBe('Privet, mir');
    expect(romanizeLine('Καλημέρα', 'el')).toBe('Kalimera');
    expect(romanizeLine('hello', 'en')).toBeUndefined();
  });
});
