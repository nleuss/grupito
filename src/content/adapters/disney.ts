// Disney+: the player downloads an HLS master playlist that lists WebVTT subtitle renditions.
// We download the rendition's media playlist and concatenate its VTT segments.
import type { Cue, TrackInfo, VideoInfo } from '../../shared/types';
import { parseHlsMaster, parseHlsMedia, type HlsRendition } from '../../subtitles/hls';
import { parseSubtitles } from '../../subtitles/parsers';
import { mapLimit } from '../../shared/util';
import { SiteAdapter, deepQueryAll, pickMainVideo, textOf } from './base';

export class DisneyAdapter extends SiteAdapter {
  readonly site = 'disney' as const;
  override hideNativeCss =
    '.dss-subtitle-renderer-wrapper, .hive-subtitle-renderer-wrapper, [class*="subtitle-renderer"] { visibility: hidden !important; }';
  private renditions: HlsRendition[] = [];
  private masterVideoId: string | null = null;

  start() {
    this.bridge.on('hls:master', (p: { url: string; text: string }) => {
      const r = parseHlsMaster(p.text, p.url);
      if (!r.length) return;
      this.renditions = r;
      this.masterVideoId = this.currentVideo()?.id ?? null;
      this.refresh();
    });
  }

  currentVideo(): VideoInfo | null {
    const m = location.pathname.match(/\/(?:video|play)\/([\w-]+)/) ?? (__TEST__ ? ['', 'test'] : null);
    if (!m) return null;
    const title = textOf('.title-field') || textOf('[data-testid="title"]') || document.title.replace(/\s*\|\s*Disney\+.*$/i, '');
    return { site: 'disney', id: m[1], title: title || 'Disney+', url: location.href };
  }

  override refresh() {
    const v = this.currentVideo();
    if (!v || !this.renditions.length) return;
    if (this.masterVideoId && this.masterVideoId !== v.id) return;
    const tracks: TrackInfo[] = this.renditions.map((r) => ({
      id: `${r.lang}|${r.name}|${r.forced ? 'f' : ''}`,
      lang: r.lang,
      label: r.forced ? `${r.name} (forced)` : r.name,
      kind: r.forced ? 'forced' : /transcribes-spoken-dialog|describes-music/.test(r.characteristics) ? 'captions' : 'subtitles',
      data: r.uri,
    }));
    this.listener.onTracks(v, tracks);
  }

  override findVideo(): HTMLVideoElement | null {
    const direct = Array.from(document.querySelectorAll('video'));
    return pickMainVideo(direct.length ? direct : deepQueryAll<HTMLVideoElement>('video'));
  }

  async loadTrack(track: TrackInfo): Promise<Cue[]> {
    const uri = track.data as string;
    const playlist = await this.fetchText(uri);
    const segments = parseHlsMedia(playlist, uri);
    if (!segments.length) return parseSubtitles(playlist);
    const texts = await mapLimit(segments, 6, (u) => this.fetchText(u).catch(() => ''));
    const cues: Cue[] = [];
    for (const t of texts) {
      if (!t.trim()) continue;
      try {
        cues.push(...parseSubtitles(t));
      } catch {
        /* skip non-text segments */
      }
    }
    return cues;
  }
}
