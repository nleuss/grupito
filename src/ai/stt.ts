// Speech-to-text through any OpenAI-compatible /audio/transcriptions endpoint
// (OpenAI whisper-1, Groq whisper-large-v3(-turbo), local whisper.cpp / faster-whisper servers…).
import type { SttSegment } from '../shared/types';
import { baseLang } from '../shared/languages';

export interface SttConfig {
  baseUrl: string;
  model: string;
  key: string;
}

// Phrases Whisper tends to invent over silence or music.
const HALLUCINATIONS = [
  /^(thanks|thank you) for watching[.!]*$/i,
  /^subtitles? by/i,
  /amara\.org/i,
  /^gracias por ver(el vídeo)?[.!]*$/i,
  /^subtítulos (realizados )?por/i,
  /^ご視聴ありがとうございました/,
  /^字幕/,
  /^\[?(music|música|musique)\]?$/i,
];

interface VerboseSegment {
  start: number;
  end: number;
  text: string;
  no_speech_prob?: number;
  avg_logprob?: number;
}

export async function transcribe(wav: Blob, durationSec: number, cfg: SttConfig, lang?: string, prompt?: string, signal?: AbortSignal): Promise<SttSegment[]> {
  const verbose = !/gpt-4o/i.test(cfg.model); // gpt-4o-*-transcribe only supports json/text
  const fd = new FormData();
  fd.append('file', wav, 'audio.wav');
  fd.append('model', cfg.model);
  fd.append('response_format', verbose ? 'verbose_json' : 'json');
  if (verbose) fd.append('timestamp_granularities[]', 'segment');
  fd.append('temperature', '0');
  if (lang) fd.append('language', baseLang(lang));
  if (prompt) fd.append('prompt', prompt.slice(-220));
  const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
    method: 'POST',
    headers: cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {},
    body: fd,
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(res.status === 401 ? 'Speech-to-text: invalid API key' : `Speech-to-text HTTP ${res.status}: ${body.slice(0, 180)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  const data = (await res.json()) as { text?: string; segments?: VerboseSegment[] };
  let segs: SttSegment[];
  if (Array.isArray(data.segments) && data.segments.length) {
    segs = data.segments
      .filter((s) => !((s.no_speech_prob ?? 0) > 0.6 && (s.avg_logprob ?? 0) < -0.8))
      .map((s) => ({ start: Math.max(0, s.start), end: Math.min(durationSec, Math.max(s.end, s.start + 0.3)), text: s.text.trim() }));
  } else if (data.text?.trim()) {
    segs = [{ start: 0, end: durationSec, text: data.text.trim() }];
  } else segs = [];
  return segs.filter((s) => s.text && !HALLUCINATIONS.some((re) => re.test(s.text)));
}
