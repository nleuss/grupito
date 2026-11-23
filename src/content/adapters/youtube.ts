// YouTube: tracks come from the player response. Caption downloads require a proof-of-origin
// token ("pot") that only YouTube's own player can produce, so we learn the exact caption URL the
// player requests (token and client parameters included) and reuse it, switching only the track
// parameters (lang / kind / name / tlang) — the same thing the player does when you change tracks.
import type { Cue, TrackInfo, VideoInfo } from '../../shared/types';
import { parseSubtitles } from '../../subtitles/parsers';
import { baseLang } from '../../shared/languages';
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

const TRACK_PARAMS = ['lang', 'kind', 'name', 'tlang', 'vssids', 'vss_id'];

export class YouTubeAdapter extends SiteAdapter {
  readonly site = 'youtube' as const;
  override hideNativeCss = '.ytp-caption-window-container, .caption-window { display: none !important; }';
  private players = new Map<string, YtPlayer>();
  /** Last caption URL YouTube's player requested, per video (preferring one with a token). */
  private playerUrls = new Map<string, URL>();
  /** Bodies of the player's caption responses keyed by "videoId|lang|kind|tlang". */
  private captured = new Map<string, string>();
  private lastHref = '';

  start() {
    this.bridge.on('yt:player', (p: YtPlayer) => {
      if (!p?.videoId) return;
      this.players.set(p.videoId, p);
      this.refresh();
    });
    this.bridge.on('yt:timedtextUrl', (p: { url: string }) => this.rememberUrl(p.url));
    this.bridge.on('yt:timedtext', (p: { url: string; text: string }) => {
      const u = this.rememberUrl(p.url);
      if (u && p.text.trim()) this.captured.set(this.keyOf(u), p.text);
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
      const v = this.currentVideo();
      if (location.href !== this.lastHref) {
        this.lastHref = location.href;
        setTimeout(ask, 800);
      } else if (v && !this.players.has(v.id)) ask();
    }, 1000);
    ask();
  }

  private rememberUrl(url: string): URL | null {
    try {
      const u = new URL(url, location.href);
      const v = u.searchParams.get('v');
      if (!v) return null;
      const prev = this.playerUrls.get(v);
      if (u.searchParams.get('pot') || !prev?.searchParams.get('pot')) this.playerUrls.set(v, u);
      return u;
    } catch {
      return null;
    }
  }

  private keyOf(u: URL) {
    return this.key(u.searchParams.get('v') ?? '', u.searchParams.get('lang'), u.searchParams.get('kind'), u.searchParams.get('tlang'));
  }

  private key(v: string, lang: string | null, kind: string | null, tlang: string | null) {
    return `${v}|${lang ?? ''}|${kind ?? ''}|${tlang ?? ''}`;
  }

  private hasToken(videoId: string) {
    return !!this.playerUrls.get(videoId)?.searchParams.get('pot');
  }

  currentVideo(): VideoInfo | null {
    let id: string | null = null;
    if (location.pathname === '/watch' || __TEST__) id = new URLSearchParams(location.search).get('v');
    const shorts = location.pathname.match(/^\/shorts\/([\w-]+)/);
    if (shorts) id = shorts[1];
    if (!id) return null;
    const title = this.players.get(id)?.title || document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '');
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
      siteTranslatable: t.translatable && p.translationLanguages.length > 0,
    }));
    this.listener.onTracks(v, tracks);
  }

  /** Lift subtitles above YouTube's control bar while it is shown (like YouTube's own captions do). */
  override observeControls(cb: (liftPx: number) => void) {
    let observed: Element | null = null;
    const update = () => {
      const p = document.getElementById('movie_player');
      const visible = !!p && !p.classList.contains('ytp-autohide') && !p.classList.contains('ytp-hide-controls');
      cb(visible ? (p!.classList.contains('ytp-fullscreen') ? 72 : 52) : 0);
    };
    const mo = new MutationObserver(update);
    const attach = () => {
      const p = document.getElementById('movie_player');
      if (p && p !== observed) {
        mo.disconnect();
        mo.observe(p, { attributes: true, attributeFilter: ['class'] });
        observed = p;
        update();
      }
    };
    attach();
    setInterval(attach, 1000);
  }

  /** Pre-roll and mid-roll ads play in the same <video>: no subtitles meanwhile. */
  override isSuppressed(): boolean {
    const p = document.getElementById('movie_player');
    return !!p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting'));
  }

  async loadTrack(track: TrackInfo): Promise<Cue[]> {
    return this.load(track, null);
  }

  override async loadSiteTranslation(track: TrackInfo, lang: string): Promise<Cue[] | null> {
    const t = track.data as YtTrack;
    const v = this.currentVideo();
    const codes = (v && this.players.get(v.id)?.translationLanguages) || [];
    if (!t?.translatable || !codes.length) return null;
    const code = codes.includes(lang) ? lang : codes.find((c) => baseLang(c) === baseLang(lang));
    if (!code) return null;
    return this.load(track, code);
  }

  buildUrl(t: YtTrack, videoId: string, tlang: string | null): string {
    const base = new URL(t.baseUrl, location.origin);
    const player = this.playerUrls.get(videoId);
    let u: URL;
    if (player) {
      u = new URL(player.href);
      for (const k of TRACK_PARAMS) u.searchParams.delete(k);
      for (const k of ['lang', 'kind', 'name']) {
        const val = base.searchParams.get(k);
        if (val) u.searchParams.set(k, val);
      }
    } else u = base;
    u.searchParams.set('fmt', 'json3');
    if (tlang) u.searchParams.set('tlang', tlang);
    else u.searchParams.delete('tlang');
    return u.href;
  }

  private async waitFor(cond: () => boolean, ms: number): Promise<boolean> {
    for (let waited = 0; waited < ms; waited += 150) {
      if (cond()) return true;
      await sleep(150);
    }
    return cond();
  }

  private clickCaptionsButton() {
    const b = document.querySelector<HTMLElement>('.ytp-subtitles-button');
    if (b && b.getAttribute('aria-pressed') !== 'true') b.click();
  }

  private async load(track: TrackInfo, tlang: string | null): Promise<Cue[]> {
    const t = track.data as YtTrack;
    const v = this.currentVideo();
    if (!v) throw new Error('No video');
    const k = this.key(v.id, t.lang, t.kind || null, tlang);
    const fromPlayer = () => this.captured.get(k);
    const tryFetch = async () => {
      const text = await this.bridge.pageFetch(this.buildUrl(t, v.id, tlang)).catch(() => '');
      return text.trim() ? text : '';
    };

    let text = fromPlayer() ?? (await tryFetch());
    if (!text && !this.hasToken(v.id)) {
      // Make the player request captions so we can reuse its token: first through its API,
      // then, if that did nothing, by pressing the CC button like a user would.
      await this.bridge.request('yt:enableCaptions', { lang: t.lang, kind: t.kind || undefined }).catch(() => {});
      const ready = () => this.hasToken(v.id) || !!fromPlayer();
      if (!(await this.waitFor(ready, 5000))) {
        this.clickCaptionsButton();
        await this.waitFor(ready, 6000);
      }
      text = fromPlayer() ?? (await tryFetch());
    }
    if (!text) throw new Error('YouTube returned no captions for this track');
    return parseSubtitles(text);
  }
}
