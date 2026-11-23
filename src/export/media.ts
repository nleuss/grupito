// Media for Anki cards made from local videos: frame screenshots (JPEG) and audio clips (MP3).
import { Mp3Encoder } from '@breezystack/lamejs';

/** Grab a frame at `time` using a hidden copy of the video so playback is not disturbed. */
export class FrameGrabber {
  private video: HTMLVideoElement;
  private canvas = document.createElement('canvas');

  constructor(src: string, private maxWidth = 640) {
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.preload = 'auto';
    this.video.src = src;
  }

  async grab(time: number): Promise<Uint8Array | null> {
    const v = this.video;
    if (v.readyState < 1) await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      v.addEventListener('seeked', done, { once: true });
      v.currentTime = Math.min(Math.max(0, time), Math.max(0, (v.duration || time) - 0.05));
      setTimeout(done, 4000);
    });
    if (!v.videoWidth) return null;
    const scale = Math.min(1, this.maxWidth / v.videoWidth);
    this.canvas.width = Math.round(v.videoWidth * scale);
    this.canvas.height = Math.round(v.videoHeight * scale);
    this.canvas.getContext('2d')!.drawImage(v, 0, 0, this.canvas.width, this.canvas.height);
    const blob = await new Promise<Blob | null>((r) => this.canvas.toBlob(r, 'image/jpeg', 0.82));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  }

  dispose() {
    this.video.removeAttribute('src');
    this.video.load();
  }
}

/** Decode a media file's audio track to mono PCM at the given sample rate. */
export async function decodeAudio(file: Blob, sampleRate: number): Promise<Float32Array> {
  const buf = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, sampleRate);
  const audio = await ctx.decodeAudioData(buf);
  if (audio.numberOfChannels === 1) return audio.getChannelData(0);
  const out = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const ch = audio.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += ch[i] / audio.numberOfChannels;
  }
  return out;
}

export function encodeMp3(samples: Float32Array, sampleRate: number, kbps = 64): Uint8Array {
  const enc = new Mp3Encoder(1, sampleRate, kbps);
  const block = 1152;
  const parts: Uint8Array[] = [];
  const pcm = new Int16Array(block);
  for (let i = 0; i < samples.length; i += block) {
    const n = Math.min(block, samples.length - i);
    for (let k = 0; k < n; k++) {
      const s = Math.max(-1, Math.min(1, samples[i + k]));
      pcm[k] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const out = enc.encodeBuffer(n === block ? pcm : pcm.subarray(0, n));
    if (out.length) parts.push(new Uint8Array(out));
  }
  const end = enc.flush();
  if (end.length) parts.push(new Uint8Array(end));
  const total = parts.reduce((a, p) => a + p.length, 0);
  const mp3 = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    mp3.set(p, o);
    o += p.length;
  }
  return mp3;
}

export function clip(samples: Float32Array, sampleRate: number, start: number, end: number, pad = 0.25): Float32Array {
  const a = Math.max(0, Math.floor((start - pad) * sampleRate));
  const b = Math.min(samples.length, Math.ceil((end + pad) * sampleRate));
  return samples.subarray(a, Math.max(a, b));
}
