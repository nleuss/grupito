import { describe, expect, it } from 'vitest';
import { detectFormat, parseAss, parseJson3, parseSrt, parseSubtitles, parseTtml, parseVtt, parseYouTubeXml } from '../../src/subtitles/parsers';
import { cleanCueText } from '../../src/subtitles/text';

describe('cleanCueText', () => {
  it('strips tags, ruby text, entities and bidi marks', () => {
    expect(cleanCueText('<c.japanese><ruby>漢字<rt>かんじ</rt></ruby>です</c.japanese>')).toBe('漢字です');
    expect(cleanCueText('&lrm;<i>Hello</i> &amp; <b>bye</b>&nbsp;')).toBe('Hello & bye');
    expect(cleanCueText('{\\an8}Top line\n\n  second  ')).toBe('Top line\nsecond');
  });
});

describe('WebVTT', () => {
  const vtt = `WEBVTT
X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000

STYLE
::cue { color: white }

NOTE this is a comment

1
00:00:01.000 --> 00:00:03.500 position:50% line:85%
<v Roger>Hello there!</v>

intro
00:01.000 --> 00:02.000
Short timestamps
with two lines

01:00:00.250 --> 01:00:02.000
<00:00:00.500>Karaoke <00:00:01.000>style
`;
  it('parses cues, settings, identifiers and short timestamps', () => {
    const cues = parseVtt(vtt);
    expect(cues).toEqual([
      { start: 1, end: 3.5, text: 'Hello there!' },
      { start: 1, end: 2, text: 'Short timestamps\nwith two lines' },
      { start: 3600.25, end: 3602, text: 'Karaoke style' },
    ]);
    expect(detectFormat(vtt)).toBe('vtt');
  });
});

describe('SRT', () => {
  it('parses comma decimals, CRLF and font tags', () => {
    const srt = '1\r\n00:00:01,000 --> 00:00:02,500\r\n<font color="#fff">Hola</font>\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n¿Qué tal?\r\n';
    expect(parseSrt(srt)).toEqual([
      { start: 1, end: 2.5, text: 'Hola' },
      { start: 3, end: 4, text: '¿Qué tal?' },
    ]);
    expect(detectFormat(srt)).toBe('srt');
  });
});

describe('TTML', () => {
  it('parses Netflix-style DFXP with tick rate and <br/>', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000">
  <body><div>
    <p begin="10000000t" end="25000000t">Line one<br/>line two</p>
    <p begin="30000000t" end="40000000t"><span>Span</span> text</p>
  </div></body></tt>`;
    expect(parseTtml(xml)).toEqual([
      { start: 1, end: 2.5, text: 'Line one\nline two' },
      { start: 3, end: 4, text: 'Span text' },
    ]);
    expect(detectFormat(xml)).toBe('ttml');
  });

  it('parses Prime-style prefixed TTML with clock times and nested begin offsets', () => {
    const xml = `<?xml version="1.0"?>
<tt:tt xmlns:tt="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling">
<tt:body><tt:div begin="00:00:10.000">
  <tt:p begin="00:00:01.418" end="00:00:04.087">I&apos;m here.</tt:p>
  <tt:p begin="5s" dur="1500ms">Second</tt:p>
</tt:div></tt:body></tt:tt>`;
    const cues = parseTtml(xml);
    expect(cues[0].text).toBe("I'm here.");
    expect(cues[0].start).toBeCloseTo(11.418);
    expect(cues[0].end).toBeCloseTo(14.087);
    expect(cues[1]).toEqual({ start: 15, end: 16.5, text: 'Second' });
  });

  it('drops IMSC ruby text and handles frame-based times', () => {
    const xml = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:frameRate="24" ttp:frameRateMultiplier="1000 1001">
<head><styling><style xml:id="rt" tts:ruby="text"/></styling></head>
<body><div><p begin="00:00:01:12" end="00:00:03:00"><span tts:ruby="container"><span tts:ruby="base">漢字</span><span style="rt">かんじ</span></span>を読む</p></div></body></tt>`;
    const [cue] = parseTtml(xml);
    expect(cue.text).toBe('漢字を読む');
    expect(cue.start).toBeCloseTo(1 + 12 / (24 * 1000 / 1001), 4);
  });
});

describe('YouTube', () => {
  it('parses json3 and skips append/newline events', () => {
    const json = {
      events: [
        { tStartMs: 0, dDurationMs: 5000, id: 1, wWinId: 1 },
        { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'hello' }, { utf8: ' world', tOffsetMs: 500 }] },
        { tStartMs: 2900, dDurationMs: 100, aAppend: 1, segs: [{ utf8: '\n' }] },
        { tStartMs: 3000, dDurationMs: 0, segs: [{ utf8: 'next &amp; line' }] },
      ],
    };
    expect(parseJson3(JSON.stringify(json))).toEqual([
      { start: 1, end: 3, text: 'hello world' },
      { start: 3, end: 5, text: 'next & line' },
    ]);
    expect(detectFormat(JSON.stringify(json))).toBe('json3');
  });

  it('parses srv3 and transcript XML', () => {
    expect(parseYouTubeXml('<timedtext format="3"><body><p t="1500" d="1000">Hi <s>there</s></p></body></timedtext>')).toEqual([
      { start: 1.5, end: 2.5, text: 'Hi there' },
    ]);
    expect(parseSubtitles('<transcript><text start="2.5" dur="1.25">It&amp;#39;s fine</text></transcript>')).toEqual([
      { start: 2.5, end: 3.75, text: "It's fine" },
    ]);
  });
});

describe('ASS', () => {
  it('parses dialogue lines with commas and override tags', () => {
    const ass = `[Script Info]
Title: test

[V4+ Styles]
Format: Name, Fontname

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,{\\i1}Hello, friend{\\i0}\\Nsecond line
Comment: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,ignored`;
    expect(parseAss(ass)).toEqual([{ start: 1.5, end: 3, text: 'Hello, friend\nsecond line' }]);
    expect(detectFormat(ass)).toBe('ass');
  });
});
