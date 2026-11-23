// Audio helpers for speech-to-text: resampling, silence-aware chunking and WAV encoding.

export const STT_RATE = 16000;

/** Downmix is done by the caller; this resamples mono Float32 audio by box-averaging. */
export function downsample(input: Float32Array, fromRate: number, toRate = STT_RATE): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let j = 0; j < outLen; j++) {
    const a = Math.floor(j * ratio);
    const b = Math.min(input.length, Math.floor((j + 1) * ratio));
    let sum = 0;
    for (let i = a; i < b; i++) sum += input[i];
    out[j] = b > a ? sum / (b - a) : input[a] ?? 0;
  }
  return out;
}

export function rms(samples: Float32Array, start = 0, end = samples.length): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, end - start));
}

export function encodeWav(samples: Float32Array, sampleRate = STT_RATE): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export interface ChunkOptions {
  sampleRate: number;
  minSec: number;
  maxSec: number;
  silenceRms: number;
  silenceMs: number;
}

export interface AudioChunk {
  samples: Float32Array;
  /** Start of the chunk: wall-clock ms (live capture) or seconds into the file (offline). */
  start: number;
  /** True when the chunk is (almost) all silence; callers usually skip these. */
  silent: boolean;
}

/**
 * Accumulates audio and cuts it into chunks at pauses in speech, so words are not split
 * between transcription requests.
 */
export class Chunker {
  private parts: Float32Array[] = [];
  private length = 0;
  private start = 0;
  private readonly frame: number;

  constructor(
    private opts: ChunkOptions,
    private onChunk: (c: AudioChunk) => void,
    /** Units per sample for `start` (ms per sample for wall clock, seconds per sample offline). */
    private unitPerSample = 1000 / opts.sampleRate,
  ) {
    this.frame = Math.round(opts.sampleRate * 0.02);
  }

  push(samples: Float32Array, start: number) {
    if (!this.length) this.start = start;
    this.parts.push(samples);
    this.length += samples.length;
    this.maybeCut();
  }

  flush() {
    if (this.length) this.emit(this.length);
  }

  private concat(): Float32Array {
    if (this.parts.length === 1) return this.parts[0];
    const all = new Float32Array(this.length);
    let o = 0;
    for (const p of this.parts) {
      all.set(p, o);
      o += p.length;
    }
    this.parts = [all];
    return all;
  }

  private maybeCut(): void {
    const { sampleRate, minSec, maxSec, silenceRms, silenceMs } = this.opts;
    if (this.length < minSec * sampleRate) return;
    const all = this.concat();
    const need = Math.ceil((silenceMs / 1000) * sampleRate / this.frame);
    // Look for a run of quiet frames after the minimum length.
    let quiet = 0;
    for (let f = Math.floor((minSec * sampleRate) / this.frame); (f + 1) * this.frame <= all.length; f++) {
      if (rms(all, f * this.frame, (f + 1) * this.frame) < silenceRms) {
        quiet++;
        if (quiet >= need) {
          this.emit((f - need + 2) * this.frame);
          return this.maybeCut();
        }
      } else quiet = 0;
    }
    if (this.length >= maxSec * sampleRate) {
      // No pause found: cut at the quietest frame of the last 2 seconds.
      const from = Math.max(0, all.length - 2 * sampleRate);
      let best = all.length;
      let bestRms = Infinity;
      for (let i = from; i + this.frame <= all.length; i += this.frame) {
        const r = rms(all, i, i + this.frame);
        // "<=" prefers the latest quiet frame, keeping chunks close to maxSec.
        if (r <= bestRms) {
          bestRms = r;
          best = i + this.frame;
        }
      }
      this.emit(best);
    }
  }

  private emit(cut: number) {
    const all = this.concat();
    const head = all.slice(0, cut);
    const tail = all.slice(cut);
    this.onChunk({ samples: head, start: this.start, silent: rms(head) < this.opts.silenceRms * 1.2 });
    this.start += cut * this.unitPerSample;
    this.parts = tail.length ? [tail] : [];
    this.length = tail.length;
  }
}
