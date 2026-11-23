// Offscreen document: Japanese/Chinese text analysis and tab-audio transcription (AI captions).
import type { OffscreenMessage, OffscreenEvent } from '../shared/messages';
import type { LineAnalysis } from '../shared/types';
import { baseLang } from '../shared/languages';
import { errorMessage } from '../shared/util';
import { analyzeJapanese } from '../text/japanese';
import { analyzeChinese } from '../text/chinese';
import { analyzeLocal } from '../text/tokenize';
import { Chunker, downsample, encodeWav, STT_RATE, type AudioChunk } from '../ai/audio';
import { transcribe, type SttConfig } from '../ai/stt';

async function analyze(lines: string[], lang: string): Promise<{ lines: LineAnalysis[] }> {
  const b = baseLang(lang);
  if (b === 'ja') return { lines: await analyzeJapanese(lines, chrome.runtime.getURL('dict/')) };
  if (b === 'zh') return { lines: lines.map(analyzeChinese) };
  return { lines: lines.map((l) => analyzeLocal(l, lang)) };
}

function emit(ev: OffscreenEvent) {
  chrome.runtime.sendMessage(ev).catch(() => {});
}

class CaptureSession {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private chunker: Chunker;
  private queue: AudioChunk[] = [];
  private inflight = 0;
  private failures = 0;
  private lastText = '';
  private stopped = false;
  private abort = new AbortController();

  constructor(
    readonly tabId: number,
    private streamId: string,
    private lang: string,
    private stt: SttConfig,
  ) {
    this.chunker = new Chunker({ sampleRate: STT_RATE, minSec: 4, maxSec: 14, silenceRms: 0.006, silenceMs: 300 }, (c) => this.enqueue(c));
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: this.streamId } } as unknown as MediaTrackConstraints,
      video: false,
    });
    const ctx = new AudioContext();
    this.ctx = ctx;
    const src = ctx.createMediaStreamSource(this.stream);
    // Capturing a tab mutes it; route the audio back to the speakers.
    src.connect(ctx.destination);
    await ctx.audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js'));
    const tap = new AudioWorkletNode(ctx, 'pcm-tap');
    const sink = ctx.createGain();
    sink.gain.value = 0;
    src.connect(tap);
    tap.connect(sink).connect(ctx.destination);
    tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (this.stopped) return;
      const batch = e.data;
      const ms = (batch.length / ctx.sampleRate) * 1000;
      const wallStart = Date.now() - ms - (ctx.outputLatency || 0) * 1000;
      this.chunker.push(downsample(batch, ctx.sampleRate, STT_RATE), wallStart);
    };
    this.stream.getAudioTracks()[0]?.addEventListener('ended', () => this.stop('Tab capture ended'));
  }

  private enqueue(c: AudioChunk) {
    if (c.silent || this.stopped) return;
    this.queue.push(c);
    // If the API falls behind, drop the oldest audio rather than lagging further and further.
    while (this.queue.length > 6) this.queue.shift();
    this.pump();
  }

  private pump() {
    while (this.inflight < 2 && this.queue.length && !this.stopped) {
      const c = this.queue.shift()!;
      this.inflight++;
      const dur = c.samples.length / STT_RATE;
      transcribe(encodeWav(c.samples), dur, this.stt, this.lang, this.lastText, this.abort.signal)
        .then((segments) => {
          this.failures = 0;
          if (!segments.length || this.stopped) return;
          this.lastText = segments.map((s) => s.text).join(' ');
          emit({ type: 'offscreen:aiResult', tabId: this.tabId, wallStart: c.start, segments });
        })
        .catch((e: Error & { status?: number }) => {
          if (this.stopped) return;
          this.failures++;
          if (e.status === 401 || e.status === 403 || e.status === 404 || this.failures >= 4) this.stop(errorMessage(e));
        })
        .finally(() => {
          this.inflight--;
          this.pump();
        });
    }
  }

  stop(error?: string) {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    sessions.delete(this.tabId);
    emit({ type: 'offscreen:aiState', tabId: this.tabId, active: false, error });
  }
}

const sessions = new Map<number, CaptureSession>();

async function handle(msg: OffscreenMessage): Promise<unknown> {
  switch (msg.type) {
    case 'analyze':
      return analyze(msg.lines, msg.lang);
    case 'capture:start': {
      sessions.get(msg.tabId)?.stop();
      const s = new CaptureSession(msg.tabId, msg.streamId, msg.lang, msg.stt);
      sessions.set(msg.tabId, s);
      try {
        await s.start();
      } catch (e) {
        sessions.delete(msg.tabId);
        throw e;
      }
      return { started: true };
    }
    case 'capture:stop':
      sessions.get(msg.tabId)?.stop();
      return { stopped: true };
    case 'ping':
      return { pong: true };
  }
}

chrome.runtime.onMessage.addListener((msg: OffscreenMessage, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  handle(msg).then(
    (data) => sendResponse({ ok: true, data }),
    (e) => sendResponse({ ok: false, error: errorMessage(e) }),
  );
  return true;
});
