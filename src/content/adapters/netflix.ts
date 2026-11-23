// Netflix: subtitle tracks come from the playback manifest (captured via JSON.parse in the
// main world). Seeking must go through Netflix's player API: setting video.currentTime
// directly makes the player crash.
import type { Cue, TrackInfo, VideoInfo } from '../../shared/types';
import { parseSubtitles } from '../../subtitles/parsers';
import { SiteAdapter, textOf } from './base';

interface NetflixTrack {
  id: string;
  lang: string;
  label: string;
  cc: boolean;
  forced: boolean;
  urls: Record<string, string[]>;
}

const FORMAT_PREFERENCE = ['webvtt-lssdh-ios8', 'imsc1.1', 'dfxp-ls-sdh', 'simplesdh', 'nflx-cmisc'];

export class NetflixAdapter extends SiteAdapter {
  readonly site = 'netflix' as const;
  override hideNativeCss = '.player-timedtext, .player-timedtext-text-container { visibility: hidden !important; }';
  private byMovie = new Map<string, TrackInfo[]>();
  private titles = new Map<string, string>();

  start() {
    this.bridge.on('netflix:manifest', (p: { movieId: string; tracks: NetflixTrack[] }) => {
      const tracks: TrackInfo[] = p.tracks.map((t) => ({
        id: t.id,
        lang: t.lang,
        label: t.label,
        kind: t.forced ? 'forced' : t.cc ? 'captions' : 'subtitles',
        data: t.urls,
      }));
      this.byMovie.set(String(p.movieId), tracks);
      this.refresh();
    });
  }

  currentVideo(): VideoInfo | null {
    const m = location.pathname.match(/\/watch\/(\d+)/);
    if (!m) return null;
    // The title element only exists while the player controls are visible: remember it.
    const shown = textOf('[data-uia="video-title"]');
    if (shown) this.titles.set(m[1], shown);
    const title = this.titles.get(m[1]) || document.title.replace(/\s*[|-]\s*Netflix.*$/i, '') || 'Netflix';
    return { site: 'netflix', id: m[1], title, url: `https://www.netflix.com/watch/${m[1]}` };
  }

  override refresh() {
    const v = this.currentVideo();
    const tracks = v && this.byMovie.get(v.id);
    if (v && tracks) this.listener.onTracks(v, tracks);
  }

  async loadTrack(track: TrackInfo): Promise<Cue[]> {
    const urls = track.data as Record<string, string[]>;
    const fmt = FORMAT_PREFERENCE.find((f) => urls[f]?.length) ?? Object.keys(urls)[0];
    let lastErr: unknown;
    for (const url of urls[fmt] ?? []) {
      try {
        return parseSubtitles(await this.fetchText(url));
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr ?? new Error('No subtitle URL');
  }

  override play(video: HTMLVideoElement) {
    this.bridge.request('netflix:play').catch(() => video.play().catch(() => {}));
  }

  override pause(video: HTMLVideoElement) {
    this.bridge.request('netflix:pause').catch(() => video.pause());
  }

  override seek(video: HTMLVideoElement, time: number) {
    this.bridge.request('netflix:seek', { ms: Math.max(0, Math.round(time * 1000)) }).catch(() => {
      // Fallback (may be refused by the player, but better than nothing).
      video.currentTime = Math.max(0, time);
    });
  }
}
