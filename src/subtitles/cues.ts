// Operations on cue lists: normalization, lookup by time, bilingual alignment, export.
import type { Cue } from '../shared/types';
import { formatTimestamp } from '../shared/util';

export interface NormalizeOptions {
  /** Trim each cue so it ends when the next one starts (rolling auto-captions). */
  trimOverlaps?: boolean;
}

/** Sort, drop invalid cues, merge duplicates (HLS segment overlaps) and same-time fragments. */
export function normalizeCues(cues: Cue[], opts: NormalizeOptions = {}): Cue[] {
  const sorted = cues
    .filter((c) => c.text && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start)
    .map((c) => ({ start: c.start, end: c.end, text: c.text }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Cue[] = [];
  for (const c of sorted) {
    const prev = out[out.length - 1];
    if (prev) {
      if (prev.text === c.text && c.start <= prev.end + 0.05) {
        prev.end = Math.max(prev.end, c.end);
        continue;
      }
      if (Math.abs(prev.start - c.start) < 0.01 && Math.abs(prev.end - c.end) < 0.01) {
        if (!prev.text.split('\n').includes(c.text)) prev.text += '\n' + c.text;
        continue;
      }
    }
    out.push(c);
  }
  if (opts.trimOverlaps) {
    for (let i = 0; i < out.length - 1; i++) {
      if (out[i].end > out[i + 1].start) out[i].end = Math.max(out[i].start + 0.2, out[i + 1].start);
    }
  }
  return out;
}

/** Index of the last cue whose start <= t, or -1. */
export function lastStartedIndex(cues: Cue[], t: number): number {
  let lo = 0;
  let hi = cues.length - 1;
  let last = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) {
      last = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return last;
}

/** Indices of all cues active at time t (usually 0 or 1). */
export function activeCueIndices(cues: Cue[], t: number): number[] {
  const last = lastStartedIndex(cues, t);
  const res: number[] = [];
  for (let i = last; i >= 0 && i > last - 10; i--) {
    if (cues[i].end > t) res.unshift(i);
  }
  return res;
}

/**
 * For each primary cue, the text of the secondary cues that belong to it.
 * Each secondary cue is assigned to the primary cue it overlaps most; primary cues
 * left without text borrow the secondary cue they overlap most.
 */
export function alignCues(primary: Cue[], secondary: Cue[]): string[] {
  const assigned: string[][] = primary.map(() => []);
  const overlap = (a: Cue, b: Cue) => Math.min(a.end, b.end) - Math.max(a.start, b.start);
  let i0 = 0;
  for (const s of secondary) {
    while (i0 < primary.length && primary[i0].end <= s.start) i0++;
    let best = -1;
    let bestOv = 0;
    for (let i = i0; i < primary.length && primary[i].start < s.end; i++) {
      const ov = overlap(primary[i], s);
      if (ov > bestOv) {
        bestOv = ov;
        best = i;
      }
    }
    if (best >= 0) assigned[best].push(s.text);
  }
  let j0 = 0;
  return primary.map((p, i) => {
    if (assigned[i].length) return assigned[i].join('\n');
    while (j0 < secondary.length && secondary[j0].end <= p.start) j0++;
    let bestText = '';
    let bestOv = 0;
    for (let j = j0; j < secondary.length && secondary[j].start < p.end; j++) {
      const ov = overlap(p, secondary[j]);
      if (ov > bestOv) {
        bestOv = ov;
        bestText = secondary[j].text;
      }
    }
    return bestText;
  });
}

/** Shift every cue by `offset` seconds. */
export function shiftCues(cues: Cue[], offset: number): Cue[] {
  return cues.map((c) => ({ ...c, start: c.start + offset, end: c.end + offset }));
}

export function toSrt(cues: Cue[], secondLines?: (string | null | undefined)[]): string {
  return cues
    .map((c, i) => {
      const extra = secondLines?.[i] ? `\n${secondLines[i]}` : '';
      return `${i + 1}\n${formatTimestamp(c.start, ',')} --> ${formatTimestamp(c.end, ',')}\n${c.text}${extra}\n`;
    })
    .join('\n');
}

export function toVtt(cues: Cue[], secondLines?: (string | null | undefined)[]): string {
  const body = cues
    .map((c, i) => {
      const extra = secondLines?.[i] ? `\n${secondLines[i]}` : '';
      return `${formatTimestamp(c.start, '.')} --> ${formatTimestamp(c.end, '.')}\n${c.text}${extra}\n`;
    })
    .join('\n');
  return `WEBVTT\n\n${body}`;
}
