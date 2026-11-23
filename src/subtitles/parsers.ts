// Subtitle parsers: WebVTT, SRT, TTML/DFXP/IMSC, YouTube json3/srv3, ASS/SSA.
import type { Cue } from '../shared/types';
import { cleanCueText, decodeEntities } from './text';

const TIMING =
  /((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)/;

/** "01:02:03.456", "02:03,4", "1:02:03" -> seconds */
export function parseClock(v: string): number {
  const parts = v.trim().replace(',', '.').split(':');
  let secs = 0;
  for (const p of parts) secs = secs * 60 + parseFloat(p);
  return secs;
}

/** Block-based parser shared by WebVTT and SRT. */
function parseTimedBlocks(input: string): Cue[] {
  const text = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const cues: Cue[] = [];
  for (const block of text.split(/\n[ \t]*\n/)) {
    const lines = block.split('\n');
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx < 0) continue; // header, NOTE, STYLE, REGION, index-only blocks
    const m = lines[idx].match(TIMING);
    if (!m) continue;
    const start = parseClock(m[1]);
    const end = parseClock(m[2]);
    const body = cleanCueText(lines.slice(idx + 1).join('\n'));
    if (body && end > start) cues.push({ start, end, text: body });
  }
  return cues;
}

export const parseVtt = parseTimedBlocks;
export const parseSrt = parseTimedBlocks;

// ---------------------------------------------------------------- TTML / DFXP / IMSC

interface TtmlTiming {
  frameRate: number;
  subFrameRate: number;
  tickRate: number;
}

function ttAttr(el: Element, name: string): string | null {
  // Attributes may be namespaced (ttp:tickRate, tts:ruby) or not; match on local name.
  for (const a of Array.from(el.attributes)) {
    if (a.localName === name) return a.value;
  }
  return null;
}

export function parseTtmlTime(v: string | null, t: TtmlTiming): number | null {
  if (!v) return null;
  v = v.trim();
  let m = v.match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (m) return +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]);
  m = v.match(/^(\d+):(\d{2}):(\d{2}):(\d+)(?:\.(\d+))?$/);
  if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3] + (+m[4] + (m[5] ? +m[5] / t.subFrameRate : 0)) / t.frameRate;
  m = v.match(/^(\d+(?:\.\d+)?)(h|ms|m|s|f|t)$/);
  if (m) {
    const n = parseFloat(m[1]);
    switch (m[2]) {
      case 'h':
        return n * 3600;
      case 'm':
        return n * 60;
      case 's':
        return n;
      case 'ms':
        return n / 1000;
      case 'f':
        return n / t.frameRate;
      case 't':
        return n / t.tickRate;
    }
  }
  return null;
}

export function parseTtml(xml: string): Cue[] {
  const doc = new DOMParser().parseFromString(xml.replace(/^﻿/, ''), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Invalid TTML document');
  const tt = doc.documentElement;
  const frameRateBase = parseFloat(ttAttr(tt, 'frameRate') ?? '') || 30;
  const mult = (ttAttr(tt, 'frameRateMultiplier') ?? '1 1').split(/\s+/).map(Number);
  const frameRate = frameRateBase * ((mult[0] || 1) / (mult[1] || 1));
  const subFrameRate = parseFloat(ttAttr(tt, 'subFrameRate') ?? '') || 1;
  const tickAttr = parseFloat(ttAttr(tt, 'tickRate') ?? '');
  const timing: TtmlTiming = {
    frameRate,
    subFrameRate,
    tickRate: tickAttr || (ttAttr(tt, 'frameRate') ? frameRate * subFrameRate : 1),
  };

  // Styles that mark ruby text (IMSC 1.1 / TTML2), so we can drop furigana annotations.
  const rubyTextStyles = new Set<string>();
  for (const st of Array.from(doc.getElementsByTagNameNS('*', 'style'))) {
    const id = st.getAttribute('xml:id') ?? ttAttr(st, 'id');
    if (id && /^(text|textContainer)$/.test(ttAttr(st, 'ruby') ?? '')) rubyTextStyles.add(id);
  }

  const isRubyText = (el: Element) => {
    const r = ttAttr(el, 'ruby');
    if (r === 'text' || r === 'textContainer') return true;
    const styles = (el.getAttribute('style') ?? '').split(/\s+/);
    return styles.some((s) => rubyTextStyles.has(s));
  };

  const textOf = (el: Element): string => {
    let out = '';
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3 || node.nodeType === 4) {
        out += (node.nodeValue ?? '').replace(/\s+/g, ' ');
      } else if (node.nodeType === 1) {
        const child = node as Element;
        if (child.localName === 'br') out += '\n';
        else if (child.localName === 'span' && isRubyText(child)) continue;
        else out += textOf(child);
      }
    }
    return out;
  };

  const cues: Cue[] = [];
  const walk = (el: Element, parentBegin: number) => {
    const begin = parseTtmlTime(ttAttr(el, 'begin'), timing);
    const absBegin = parentBegin + (begin ?? 0);
    if (el.localName === 'p') {
      const end = parseTtmlTime(ttAttr(el, 'end'), timing);
      const dur = parseTtmlTime(ttAttr(el, 'dur'), timing);
      const absEnd = end != null ? parentBegin + end : dur != null ? absBegin + dur : null;
      if (begin != null && absEnd != null) {
        const text = cleanCueText(decodeEntities(textOf(el)));
        if (text && absEnd > absBegin) cues.push({ start: absBegin, end: absEnd, text });
      } else {
        // Timing on child spans instead of the paragraph.
        for (const span of Array.from(el.children)) walkSpan(span, absBegin);
      }
      return;
    }
    for (const child of Array.from(el.children)) walk(child, absBegin);
  };
  const walkSpan = (el: Element, parentBegin: number) => {
    const b = parseTtmlTime(ttAttr(el, 'begin'), timing);
    const e = parseTtmlTime(ttAttr(el, 'end'), timing);
    if (b == null || e == null || isRubyText(el)) return;
    const text = cleanCueText(textOf(el));
    if (text) cues.push({ start: parentBegin + b, end: parentBegin + e, text });
  };

  const body = doc.getElementsByTagNameNS('*', 'body')[0];
  if (!body) return [];
  walk(body, 0);
  return cues;
}

// ---------------------------------------------------------------- YouTube

interface Json3 {
  events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string }[] }[];
}

export function parseJson3(input: string | Json3): Cue[] {
  const data: Json3 = typeof input === 'string' ? JSON.parse(input) : input;
  const cues: Cue[] = [];
  for (const ev of data.events ?? []) {
    if (!ev.segs || ev.tStartMs == null) continue;
    const text = cleanCueText(ev.segs.map((s) => s.utf8 ?? '').join(''));
    if (!text) continue;
    const start = ev.tStartMs / 1000;
    const end = (ev.tStartMs + (ev.dDurationMs ?? 0)) / 1000;
    cues.push({ start, end: end > start ? end : start + 2, text });
  }
  return cues;
}

/** YouTube srv3 (<timedtext><body><p t= d=>) and srv1/transcript (<transcript><text start= dur=>). */
export function parseYouTubeXml(xml: string): Cue[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const cues: Cue[] = [];
  for (const p of Array.from(doc.getElementsByTagName('p'))) {
    const t = Number(p.getAttribute('t'));
    const d = Number(p.getAttribute('d') ?? 0);
    const text = cleanCueText(p.textContent ?? '');
    if (text && Number.isFinite(t)) cues.push({ start: t / 1000, end: (t + (d || 2000)) / 1000, text });
  }
  for (const el of Array.from(doc.getElementsByTagName('text'))) {
    const s = Number(el.getAttribute('start'));
    const d = Number(el.getAttribute('dur') ?? 2);
    const text = cleanCueText(decodeEntities(el.textContent ?? ''));
    if (text && Number.isFinite(s)) cues.push({ start: s, end: s + (d || 2), text });
  }
  return cues;
}

// ---------------------------------------------------------------- ASS / SSA

export function parseAss(input: string): Cue[] {
  const lines = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  let inEvents = false;
  let format: string[] = ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text'];
  const cues: Cue[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) {
      inEvents = /^\[events\]$/i.test(line);
      continue;
    }
    if (!inEvents) continue;
    if (/^format\s*:/i.test(line)) {
      format = line.replace(/^format\s*:/i, '').split(',').map((s) => s.trim());
      continue;
    }
    if (!/^dialogue\s*:/i.test(line)) continue;
    const body = line.replace(/^dialogue\s*:/i, '');
    const fields: string[] = [];
    let rest = body;
    for (let i = 0; i < format.length - 1; i++) {
      const c = rest.indexOf(',');
      if (c < 0) break;
      fields.push(rest.slice(0, c).trim());
      rest = rest.slice(c + 1);
    }
    fields.push(rest);
    const get = (name: string) => fields[format.findIndex((f) => f.toLowerCase() === name.toLowerCase())] ?? '';
    const start = parseClock(get('Start'));
    const end = parseClock(get('End'));
    const text = cleanCueText(get('Text').replace(/\\N/gi, '\n').replace(/\\h/g, ' '));
    if (text && end > start) cues.push({ start, end, text });
  }
  return cues;
}

// ---------------------------------------------------------------- detection

export type SubtitleFormat = 'vtt' | 'srt' | 'ttml' | 'json3' | 'ytxml' | 'ass';

export function detectFormat(text: string): SubtitleFormat | null {
  const t = text.replace(/^﻿/, '').trimStart();
  if (t.startsWith('WEBVTT')) return 'vtt';
  if (t.startsWith('{') && /"events"\s*:/.test(t.slice(0, 2000))) return 'json3';
  if (t.startsWith('<')) {
    const head = t.slice(0, 3000);
    if (/<(\w+:)?tt[\s>]/.test(head)) return 'ttml';
    if (/<timedtext|<transcript/.test(head)) return 'ytxml';
    return null;
  }
  if (/^\[script info\]/im.test(t.slice(0, 500)) || /^\[events\]/im.test(t)) return 'ass';
  if (TIMING.test(t.slice(0, 2000))) return 'srt';
  return null;
}

/** Parse any supported subtitle document. Throws if the format is unknown. */
export function parseSubtitles(text: string, format?: SubtitleFormat | null): Cue[] {
  const f = format ?? detectFormat(text);
  switch (f) {
    case 'vtt':
      return parseVtt(text);
    case 'srt':
      return parseSrt(text);
    case 'ttml':
      return parseTtml(text);
    case 'json3':
      return parseJson3(text);
    case 'ytxml':
      return parseYouTubeXml(text);
    case 'ass':
      return parseAss(text);
    default:
      throw new Error('Unrecognized subtitle format');
  }
}
