// Typed messaging between content scripts / extension pages and the service worker.
import type { Cue, ExplainResult, LineAnalysis, LookupResult, SttSegment } from './types';

export interface BgRequests {
  translate: { req: { lines: string[]; from: string; to: string; title?: string; context?: string }; res: { translations: string[]; provider: string } };
  lookup: { req: { word: string; lemma?: string; sentence: string; from: string; to: string }; res: LookupResult };
  explain: { req: { word: string; sentence: string; from: string; to: string }; res: ExplainResult };
  analyze: { req: { lines: string[]; lang: string }; res: { lines: LineAnalysis[] } };
  fetchText: { req: { url: string }; res: { text: string; status: number } };
  'capture:start': { req: { tabId: number; lang: string }; res: { started: boolean } };
  'capture:stop': { req: { tabId: number }; res: { stopped: boolean } };
  'capture:status': { req: { tabId: number }; res: { active: boolean; error?: string } };
  'ai:status': { req: Record<string, never>; res: { claude: boolean; deepl: boolean; stt: boolean } };
  injectGeneric: { req: { tabId: number }; res: { injected: boolean } };
  'cache:clear': { req: Record<string, never>; res: { cleared: boolean } };
  testProvider: { req: { provider: 'google' | 'deepl' | 'claude'; to: string }; res: { sample: string } };
}

export type BgType = keyof BgRequests;
export type BgMessage = { [K in BgType]: { type: K } & BgRequests[K]['req'] }[BgType];
export type BgResponse<K extends BgType> = { ok: true; data: BgRequests[K]['res'] } | { ok: false; error: string };

/** Send a request to the service worker and unwrap the response (throws on error). */
export async function bg<K extends BgType>(type: K, req: BgRequests[K]['req']): Promise<BgRequests[K]['res']> {
  const res = (await chrome.runtime.sendMessage({ type, ...req })) as BgResponse<K> | undefined;
  if (!res) throw new Error('No response from background');
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

/** Messages the service worker / popup send to a tab's content script. */
export type TabMessage =
  | { type: 'cs:status' }
  | { type: 'cs:aiCues'; wallStart: number; segments: SttSegment[] }
  | { type: 'cs:aiState'; active: boolean; error?: string }
  | { type: 'cs:command'; command: 'toggle' | 'transcript' | 'reload' };

export interface ContentStatus {
  site: string;
  active: boolean;
  videoTitle?: string;
  tracks: { id: string; label: string; lang: string }[];
  primaryLabel?: string;
  translationLabel?: string;
  cueCount: number;
  message?: string;
  aiActive?: boolean;
}

/** Messages between the service worker and the offscreen document. */
export type OffscreenMessage =
  | { target: 'offscreen'; type: 'analyze'; lines: string[]; lang: string }
  | {
      target: 'offscreen';
      type: 'capture:start';
      tabId: number;
      streamId: string;
      lang: string;
      stt: { baseUrl: string; model: string; key: string };
    }
  | { target: 'offscreen'; type: 'capture:stop'; tabId: number }
  | { target: 'offscreen'; type: 'ping' };

export type OffscreenEvent =
  | { type: 'offscreen:aiResult'; tabId: number; wallStart: number; segments: SttSegment[] }
  | { type: 'offscreen:aiState'; tabId: number; active: boolean; error?: string };

export type { Cue };
