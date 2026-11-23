// Prime Video: subtitle URLs (TTML/DFXP) arrive in the GetPlaybackResources response.
// Some titles report a video.currentTime that is offset from the content timeline, so we
// estimate the offset from the player's on-screen clock.
import type { Cue, TrackInfo, VideoInfo } from '../../shared/types';
import { parseSubtitles } from '../../subtitles/parsers';
import { parseClock } from '../../subtitles/parsers';
import { SiteAdapter, pickMainVideo } from './base';

interface PrimeTrack {
  id: string;
  lang: string;
  label: string;
  cc: boolean;
  forced: boolean;
  url: string;
}

export class PrimeAdapter extends SiteAdapter {
  readonly site = 'prime' as const;
  override hideNativeCss = '.atvwebplayersdk-captions-overlay { visibility: hidden !important; }';
  private tracks: TrackInfo[] = [];
  private videoId = '';
  private title = '';
  private offsetSamples: number[] = [];
  private offset = 0;
  private lastSample = 0;

  start() {
    this.bridge.on('prime:resources', (p: { videoId: string; title: string; tracks: PrimeTrack[] }) => {
      this.videoId = p.videoId || this.videoId || location.pathname;
      this.title = p.title || this.title;
      this.tracks = p.tracks.map((t) => ({
        id: t.id,
        lang: t.lang,
        label: t.label,
        kind: t.forced ? 'forced' : t.cc ? 'captions' : 'subtitles',
        data: t.url,
      }));
      this.offsetSamples = [];
      this.offset = 0;
      this.refresh();
    });
  }

  currentVideo(): VideoInfo | null {
    if (!this.videoId) return null;
    const title = this.title || document.querySelector('.atvwebplayersdk-title-text')?.textContent?.trim() || document.title;
    return { site: 'prime', id: this.videoId, title, url: location.href };
  }

  override refresh() {
    const v = this.currentVideo();
    if (v && this.tracks.length) this.listener.onTracks(v, this.tracks);
  }

  override findVideo(): HTMLVideoElement | null {
    const scoped = Array.from(document.querySelectorAll<HTMLVideoElement>('.webPlayerSDKContainer video, .rendererContainer video'));
    return pickMainVideo(scoped.length ? scoped : Array.from(document.querySelectorAll('video')));
  }

  async loadTrack(track: TrackInfo): Promise<Cue[]> {
    return parseSubtitles(await this.fetchText(track.data as string));
  }

  override timeOffset(video: HTMLVideoElement): number {
    const now = performance.now();
    if (now - this.lastSample > 2000 && !video.paused) {
      this.lastSample = now;
      const txt = document.querySelector('.atvwebplayersdk-timeindicator-text')?.textContent ?? '';
      const m = txt.match(/(\d+:\d{2}(?::\d{2})?)/);
      if (m) {
        const diff = parseClock(m[1]) - video.currentTime;
        this.offsetSamples.push(diff);
        if (this.offsetSamples.length > 7) this.offsetSamples.shift();
        const sorted = [...this.offsetSamples].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        // The clock only has 1 s resolution: ignore small differences.
        this.offset = Math.abs(median) > 2 ? Math.round(median * 2) / 2 : 0;
      }
    }
    return this.offset;
  }
}
