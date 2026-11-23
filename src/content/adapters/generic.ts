// Any other site with an HTML5 <video>: uses <track> elements, subtitle files the page
// downloads (when injected early enough), HLS subtitle renditions, or files the user loads.
import type { Cue, TrackInfo, VideoInfo } from '../../shared/types';
import { parseSubtitles } from '../../subtitles/parsers';
import { parseHlsMaster, parseHlsMedia } from '../../subtitles/hls';
import { mapLimit } from '../../shared/util';
import { SiteAdapter } from './base';

function guessLang(url: string): string {
  const m = url.match(/(?:[/_.-]|lang=)([a-z]{2}(?:-[A-Za-z]{2,4})?)(?=[/_.?-]|\.(?:vtt|srt|ttml|dfxp|xml)|$)/);
  return m ? m[1] : 'und';
}

export class GenericAdapter extends SiteAdapter {
  readonly site = 'generic' as const;
  private captured: TrackInfo[] = [];

  start() {
    this.bridge.on('sub:captured', (p: { url: string; text: string }) => {
      if (this.captured.some((t) => (t.data as { url?: string }).url === p.url)) return;
      try {
        const cues = parseSubtitles(p.text);
        if (!cues.length) return;
        const name = decodeURIComponent(p.url.split('?')[0].split('/').pop() ?? 'subtitles');
        this.captured.push({ id: `cap:${p.url}`, lang: guessLang(p.url), label: name, kind: 'subtitles', data: { url: p.url, cues } });
        this.refresh();
      } catch {
        /* not a subtitle */
      }
    });
    this.bridge.on('hls:master', (p: { url: string; text: string }) => {
      for (const r of parseHlsMaster(p.text, p.url)) {
        if (this.captured.some((t) => t.id === `hls:${r.uri}`)) continue;
        this.captured.push({ id: `hls:${r.uri}`, lang: r.lang, label: r.name, kind: r.forced ? 'forced' : 'subtitles', data: { hls: r.uri } });
      }
      this.refresh();
    });
    // <track> elements can appear later; re-scan periodically.
    setInterval(() => this.refresh(), 2000);
  }

  currentVideo(): VideoInfo | null {
    return { site: 'generic', id: location.origin + location.pathname, title: document.title || location.hostname, url: location.href };
  }

  private trackElements(): TrackInfo[] {
    const out: TrackInfo[] = [];
    document.querySelectorAll<HTMLTrackElement>('video track').forEach((el, i) => {
      if (el.kind && !['subtitles', 'captions', ''].includes(el.kind)) return;
      const src = el.src;
      if (!src) return;
      out.push({ id: `track:${src}`, lang: el.srclang || guessLang(src) || 'und', label: el.label || el.srclang || `Track ${i + 1}`, kind: el.kind === 'captions' ? 'captions' : 'subtitles', data: { url: src } });
    });
    return out;
  }

  override refresh() {
    const v = this.currentVideo();
    const tracks = [...this.trackElements(), ...this.captured];
    if (v && tracks.length) this.listener.onTracks(v, tracks);
  }

  async loadTrack(track: TrackInfo): Promise<Cue[]> {
    const d = track.data as { url?: string; cues?: Cue[]; hls?: string };
    if (d.cues) return d.cues;
    if (d.hls) {
      const playlist = await this.bridge.pageFetch(d.hls);
      const segs = parseHlsMedia(playlist, d.hls);
      const texts = await mapLimit(segs, 6, (u) => this.bridge.pageFetch(u).catch(() => ''));
      return texts.flatMap((t) => {
        try {
          return t.trim() ? parseSubtitles(t) : [];
        } catch {
          return [];
        }
      });
    }
    if (d.url) {
      const text = await this.bridge.pageFetch(d.url).catch(() => this.fetchText(d.url!));
      return parseSubtitles(text);
    }
    return [];
  }
}
