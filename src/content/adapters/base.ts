// Common adapter contract and helpers for streaming sites.
import type { Cue, SiteId, TrackInfo, VideoInfo } from '../../shared/types';
import type { MainBridge } from '../bridge';
import { bg } from '../../shared/messages';

export interface AdapterListener {
  /** Called whenever the adapter knows (more about) the tracks of the current video. */
  onTracks(video: VideoInfo, tracks: TrackInfo[]): void;
}

export abstract class SiteAdapter {
  abstract readonly site: SiteId;
  /** CSS injected into the page to hide the site's own subtitles while ours are shown. */
  hideNativeCss = '';

  constructor(
    protected bridge: MainBridge,
    protected listener: AdapterListener,
  ) {}

  abstract start(): void;
  /** Identity of the video currently being played, or null when not on a player page. */
  abstract currentVideo(): VideoInfo | null;
  abstract loadTrack(track: TrackInfo): Promise<Cue[]>;
  /** Site-side machine translation of a track (YouTube's "tlang"); null when unavailable. */
  async loadSiteTranslation(_track: TrackInfo, _lang: string): Promise<Cue[] | null> {
    return null;
  }

  findVideo(): HTMLVideoElement | null {
    return pickMainVideo(Array.from(document.querySelectorAll('video')));
  }

  seek(video: HTMLVideoElement, time: number): void {
    video.currentTime = Math.max(0, time);
  }

  play(video: HTMLVideoElement): void {
    video.play().catch(() => {});
  }

  pause(video: HTMLVideoElement): void {
    video.pause();
  }

  /** Report how many pixels subtitles should move up while the site's player controls are visible. */
  observeControls(_cb: (liftPx: number) => void): void {}

  /** True while subtitles must not be shown (e.g. an ad is playing in the same <video>). */
  isSuppressed(): boolean {
    return false;
  }

  /** Seconds to add to video.currentTime to get the subtitle timeline. */
  timeOffset(_video: HTMLVideoElement): number {
    return 0;
  }

  /** Re-announce tracks (after SPA navigation). */
  refresh(): void {}

  /** Fetch subtitle files: through the service worker first (host permissions), then from the page. */
  protected async fetchText(url: string): Promise<string> {
    try {
      const r = await bg('fetchText', { url });
      if (r.status >= 200 && r.status < 300) return r.text;
      throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      try {
        return await this.bridge.pageFetch(url);
      } catch {
        throw e;
      }
    }
  }
}

/** The biggest visible <video>, preferring ones with media loaded and playing. */
export function pickMainVideo(videos: HTMLVideoElement[]): HTMLVideoElement | null {
  let best: HTMLVideoElement | null = null;
  let bestScore = 0;
  for (const v of videos) {
    const r = v.getBoundingClientRect();
    const area = r.width * r.height;
    if (area < 160 * 90 || getComputedStyle(v).visibility === 'hidden') continue;
    const score = area * (v.readyState > 0 ? 2 : 1) * (v.paused ? 1 : 1.5);
    if (score > bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}

/** querySelectorAll that also descends into open shadow roots (players built with web components). */
export function deepQueryAll<T extends Element>(selector: string, root: ParentNode = document, depth = 0, out: T[] = []): T[] {
  out.push(...Array.from(root.querySelectorAll<T>(selector)));
  if (depth > 6) return out;
  const all = root.querySelectorAll('*');
  for (const el of Array.from(all)) {
    if (el.shadowRoot) deepQueryAll(selector, el.shadowRoot, depth + 1, out);
  }
  return out;
}

export function textOf(selector: string): string {
  return (document.querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();
}
