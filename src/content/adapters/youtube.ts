// YouTube: tracks come from the player response. Caption downloads may require a
// proof-of-origin token ("pot") that only the player can produce, so when a direct fetch
// comes back empty we ask the player to load that track and reuse the token it sends.
import type { Cue, TrackInfo, VideoInfo } from '../../shared/types';
import { parseSubtitles } from '../../subtitles/parsers';
import { sleep } from '../../shared/util';
import { SiteAdapter } from './base';

interface YtTrack {
  baseUrl: string;
  lang: string;
  label: string;
  kind: string;
  vssId: string;
  translatable: boolean;
}
interface YtPlayer {
  videoId: string;
  title: string;
  tracks: YtTrack[];
  translationLanguages: string[];
}

const POT_PARAMS = ['pot', 'potc', 'c', 'cver', 'cplatform', 'cbrand', 'cbr', 'cbrver', 'cos', 'cosver', 'xorb', 'xobt', 'xovt'];

export class YouTubeAdapter extends SiteAdapter {
  readonly site = 'youtube' as const;
  override hideNativeCss = '.ytp-caption-window-container, .caption-window { display: none !important; }';
  private players = new Map<string, YtPlayer>();
  /** Last timedtext URL the player itself requested, per video (contains a valid pot). */
  private potUrls = new Map<string, URL>();
  /** Bodies of captured timedtext responses keyed by "videoId|lang|kind|tlang". */
  private captured = new Map<string, string>();
  private lastHref = '';

  start() {
    this.bridge.on('yt:player', (p: YtPlayer) => {
      if (!p?.videoId) return;
      this.players.set(p.videoId, p);
      this.refresh();
    });
    this.bridge.on('yt:timedtext', (p: { url: string; text: string }) => {
      try {
        const u = new URL(p.url, location.href);
        const v = u.searchParams.get('v');
        if (!v) return;
        if (u.searchParams.get('pot')) this.potUrls.set(v, u);
        if (p.text.trim()) this.captured.set(this.key(v, u.searchParams.get('lang'), u.searchParams.get('kind'), u.searchParams.get('tlang')), p.text);
      } catch {
        /* ignore */
      }
    });
    const ask = () =>
      this.bridge
        .request<YtPlayer | null>('yt:playerResponse')
        .then((p) => {
          if (p?.videoId) {
            this.players.set(p.videoId, p);
            this.refresh();
          }
        })
        .catch(() => {});
    setInterval(() => {
      if (location.href !== this.lastHref) {
        this.lastHref = location.href;
        setTimeout(ask, 800);
      } else if (this.currentVideo() && !this.players.has(this.currentVideo()!.id)) ask();
    }, 1000);
    ask();
  }

  private key(v: string, lang: string | null, kind: string | null, tlang: string | null) {
    return `${v}|${lang ?? ''}|${kind ?? ''}|${tlang ?? ''}`;
  }

  currentVideo(): VideoInfo | null {
    let id: string | null = null;
    if (location.pathname === '/watch' || __TEST__) id = new URLSearchParams(location.search).get('v');
    const shorts = location.pathname.match(/^\/shorts\/([\w-]+)/);
    if (shorts) id = shorts[1];
    if (!id) return null;
    const title = this.players.get(id)?.title || document.title.replace(/\s*-\s*YouTube$/, '');
    return { site: 'youtube', id, title, url: `https://www.youtube.com/watch?v=${id}` };
  }

  override refresh() {
    const v = this.currentVideo();
    const p = v && this.players.get(v.id);
    if (!v || !p) return;
    const tracks: TrackInfo[] = p.tracks.map((t) => ({
      id: t.vssId || `${t.lang}${t.kind ? '.' + t.kind : ''}`,
      lang: t.lang,
      label: t.kind === 'asr' ? `${t.label} (auto)` : t.label,
      kind: t.kind === 'asr' ? 'asr' : 'subtitles',
      data: t,
      siteTranslatable: t.translatable,
    }));
    this.listener.onTracks(v, tracks);
  }

  async loadTrack(track: TrackInfo): Promise<Cue[]> {
    return this.load(track, null);
  }

  override async loadSiteTranslation(track: TrackInfo, lang: string): Promise<Cue[] | null> {
    const t = track.data as YtTrack;
    if (!t?.translatable) return null;
    return this.load(track, lang);
  }

  private buildUrl(t: YtTrack, videoId: string, tlang: string | null): string {
    const u = new URL(t.baseUrl, location.origin);
    const pot = this.potUrls.get(videoId);
    if (pot) for (const k of POT_PARAMS) if (pot.searchParams.has(k)) u.searchParams.set(k, pot.searchParams.get(k)!);
    u.searchParams.set('fmt', 'json3');
    if (tlang) u.searchParams.set('tlang', tlang);
    else u.searchParams.delete('tlang');
    return u.href;
  }

  private async load(track: TrackInfo, tlang: string | null): Promise<Cue[]> {
    const t = track.data as YtTrack;
    const v = this.currentVideo();
    if (!v) throw new Error('No video');
    const cachedKey = this.key(v.id, t.lang, t.kind || null, tlang);
    const cached = this.captured.get(cachedKey);
    if (cached) return parseSubtitles(cached);

    let text = await this.bridge.pageFetch(this.buildUrl(t, v.id, tlang)).catch(() => '');
    if (!text.trim() && !this.potUrls.has(v.id)) {
      // Make the player request captions so we can reuse its proof-of-origin token.
      await this.bridge.request('yt:enableCaptions', { lang: t.lang, kind: t.kind || undefined }).catch(() => {});
      for (let i = 0; i < 30 && !this.potUrls.has(v.id) && !this.captured.has(cachedKey); i++) await sleep(200);
      const now = this.captured.get(cachedKey);
      if (now) return parseSubtitles(now);
      text = await this.bridge.pageFetch(this.buildUrl(t, v.id, tlang)).catch(() => '');
    }
    if (!text.trim()) throw new Error('YouTube returned no captions for this track');
    return parseSubtitles(text);
  }
}
