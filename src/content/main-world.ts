// Runs in the page's MAIN world at document_start.
// Observes the subtitle data the site's own player downloads (fetch / XHR / JSON.parse) and
// forwards compact descriptions to the isolated content script. It also exposes a few
// player actions that need page context (Netflix seeking, YouTube caption API, same-origin fetch).
//
// Everything sent across is plain data; nothing received from the isolated world is evaluated.

declare global {
  interface Window {
    __vidiomaMain?: boolean;
  }
}

type Json = Record<string, unknown>;

(() => {
  if (window.__vidiomaMain) return;
  window.__vidiomaMain = true;

  const TAG = '__vidioma';
  const post = (type: string, payload: unknown, replyTo?: string) => {
    try {
      window.postMessage({ [TAG]: 'm2i', type, payload, replyTo }, '*');
    } catch {
      /* payload not cloneable: drop */
    }
  };

  const host = location.hostname;
  // Test builds can force a site adapter on localhost mock pages with ?vidioma_site=...
  const forced = __TEST__ ? new URLSearchParams(location.search).get('vidioma_site') : null;
  const isYouTube = forced ? forced === 'youtube' : /(^|\.)youtube\.com$/.test(host);
  const isNetflix = forced ? forced === 'netflix' : /(^|\.)netflix\.com$/.test(host);

  // ------------------------------------------------------------------ helpers
  const SUB_URL = /\.(vtt|webvtt|srt|ttml2?|dfxp|xml)(\?|#|$)|[?&](fmt|format)=(vtt|ttml|dfxp|srv3|json3)/i;
  const PRIME_URL = /GetPlaybackResources|GetVodPlaybackResources|\/playback\/prs\//i;
  const M3U8_URL = /\.m3u8(\?|#|$)/i;

  function classify(url: string): 'yt-timedtext' | 'yt-player' | 'prime' | 'm3u8' | 'subtitle' | null {
    if (isYouTube) {
      if (url.includes('/api/timedtext')) return 'yt-timedtext';
      if (url.includes('/youtubei/v1/player')) return 'yt-player';
      return null;
    }
    if (PRIME_URL.test(url)) return 'prime';
    if (M3U8_URL.test(url)) return 'm3u8';
    if (SUB_URL.test(url)) return 'subtitle';
    return null;
  }

  function handleBody(kind: NonNullable<ReturnType<typeof classify>>, url: string, text: string) {
    if (!text || text.length > 8_000_000) return;
    try {
      switch (kind) {
        case 'yt-timedtext':
          post('yt:timedtext', { url, text });
          break;
        case 'yt-player': {
          const pr = JSON.parse(text);
          const c = ytCompact(pr);
          if (c) post('yt:player', c);
          break;
        }
        case 'prime': {
          const data = JSON.parse(text);
          const tracks = primeTracks(data);
          if (tracks.length) {
            let videoId = '';
            try {
              videoId = new URL(url, location.href).searchParams.get('asin') ?? '';
            } catch {
              /* ignore */
            }
            const meta = (data as Json).catalogMetadata as Json | undefined;
            const title = ((meta?.catalog as Json | undefined)?.title as string | undefined) ?? '';
            post('prime:resources', { videoId, title, tracks });
          }
          break;
        }
        case 'm3u8':
          if (text.includes('TYPE=SUBTITLES')) post('hls:master', { url, text });
          break;
        case 'subtitle':
          if (/^\uFEFF?\s*(WEBVTT|<\?xml|<tt|<(\w+:)?tt[\s>]|\d+\s*\r?\n\d\d:\d\d)/.test(text.slice(0, 200))) {
            post('sub:captured', { url, text });
          }
          break;
      }
    } catch {
      /* not JSON / unexpected shape */
    }
  }

  // ------------------------------------------------------------------ fetch hook
  const origFetch = window.fetch;
  window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    const p = origFetch.apply(this, [input, init] as [RequestInfo | URL, RequestInit | undefined]);
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      const kind = classify(url);
      if (kind) {
        p.then((res) => {
          if (!res.ok) return;
          res
            .clone()
            .text()
            .then((t) => handleBody(kind, res.url || url, t))
            .catch(() => {});
        }).catch(() => {});
      }
    } catch {
      /* never break the page */
    }
    return p;
  } as typeof window.fetch;

  // ------------------------------------------------------------------ XHR hook
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;
  const urlKey = Symbol('vidiomaUrl');
  XHR.open = function (this: XMLHttpRequest & { [urlKey]?: string }, method: string, url: string | URL, ...rest: unknown[]) {
    try {
      this[urlKey] = String(url);
    } catch {
      /* ignore */
    }
    return (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XHR.open;
  XHR.send = function (this: XMLHttpRequest & { [urlKey]?: string }, body?: Document | XMLHttpRequestBodyInit | null) {
    try {
      const url = this[urlKey];
      const kind = url ? classify(url) : null;
      if (kind && url) {
        this.addEventListener('load', () => {
          try {
            if (this.status < 200 || this.status >= 300) return;
            let text = '';
            if (this.responseType === '' || this.responseType === 'text') text = this.responseText;
            else if (this.responseType === 'json') text = JSON.stringify(this.response);
            else if (this.responseType === 'arraybuffer' && this.response) text = new TextDecoder().decode(this.response as ArrayBuffer);
            handleBody(kind, this.responseURL || url, text);
          } catch {
            /* ignore */
          }
        });
      }
    } catch {
      /* ignore */
    }
    return origSend.call(this, body);
  };

  // ------------------------------------------------------------------ Netflix manifest
  if (isNetflix) {
    const origStringify = JSON.stringify;
    JSON.stringify = function (this: unknown, value: unknown, ...rest: unknown[]) {
      try {
        // Ask for WebVTT and the full list of subtitle languages in manifest requests.
        if (value && typeof value === 'object') {
          const params = ((value as Json).params ?? value) as Json;
          if (Array.isArray(params?.profiles) && (params.viewableId != null || params.type === 'standard')) {
            const profiles = params.profiles as string[];
            if (!profiles.includes('webvtt-lssdh-ios8')) profiles.push('webvtt-lssdh-ios8');
            params.showAllSubDubTracks = true;
          }
        }
      } catch {
        /* ignore */
      }
      return (origStringify as (...a: unknown[]) => string).call(this, value, ...rest);
    } as typeof JSON.stringify;

    const origParse = JSON.parse;
    JSON.parse = function (this: unknown, text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) {
      const value = origParse.call(this, text, reviver);
      try {
        if (value && typeof value === 'object' && typeof text === 'string' && text.length > 500) {
          const r = ((value as Json).result ?? value) as Json;
          if (r && Array.isArray(r.timedtexttracks) && r.movieId != null) {
            post('netflix:manifest', { movieId: String(r.movieId), tracks: netflixTracks(r.timedtexttracks as Json[]) });
          }
        }
      } catch {
        /* ignore */
      }
      return value;
    } as typeof JSON.parse;
  }

  function netflixTracks(list: Json[]) {
    const out: { id: string; lang: string; label: string; cc: boolean; forced: boolean; urls: Record<string, string[]> }[] = [];
    for (const t of list) {
      if (!t || t.isNoneTrack) continue;
      const urls: Record<string, string[]> = {};
      for (const [fmt, d] of Object.entries((t.ttDownloadables as Json) ?? {})) {
        const dd = d as Json;
        let u: string[] = [];
        if (dd?.downloadUrls && typeof dd.downloadUrls === 'object') u = Object.values(dd.downloadUrls as Record<string, string>);
        else if (Array.isArray(dd?.urls)) u = (dd.urls as (Json | string)[]).map((x) => (typeof x === 'string' ? x : (x.url as string)));
        u = u.filter((x) => typeof x === 'string');
        if (u.length) urls[fmt] = u;
      }
      if (!Object.keys(urls).length) continue;
      const cc = t.rawTrackType === 'closedcaptions';
      const lang = String(t.language ?? 'und');
      out.push({
        id: String(t.new_track_id ?? t.trackId ?? t.id ?? `${lang}-${t.rawTrackType}`),
        lang,
        label: `${t.languageDescription ?? lang}${cc ? ' [CC]' : ''}`,
        cc,
        forced: !!t.isForcedNarrative,
        urls,
      });
    }
    return out;
  }

  function netflixPlayer(): { seek(ms: number): void } | null {
    try {
      const w = window as unknown as Json;
      const vp = ((((w.netflix as Json)?.appContext as Json)?.state as Json)?.playerApp as { getAPI(): Json }).getAPI().videoPlayer as {
        getAllPlayerSessionIds(): string[];
        getVideoPlayerBySessionId(id: string): { seek(ms: number): void };
      };
      const ids = vp.getAllPlayerSessionIds();
      const id = ids.find((i) => i.includes('watch')) ?? ids[ids.length - 1];
      return id ? vp.getVideoPlayerBySessionId(id) : null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ Prime Video
  function primeTracks(data: unknown) {
    const found: (Json & { forced?: boolean })[] = [];
    const visit = (o: unknown, depth: number) => {
      if (!o || typeof o !== 'object' || depth > 7) return;
      for (const [k, v] of Object.entries(o as Json)) {
        if ((k === 'subtitleUrls' || k === 'forcedNarratives') && Array.isArray(v)) {
          for (const x of v) if (x && typeof x === 'object') found.push({ ...(x as Json), forced: k === 'forcedNarratives' });
        } else if (v && typeof v === 'object') visit(v, depth + 1);
      }
    };
    visit(data, 0);
    return found
      .filter((x) => typeof x.url === 'string')
      .map((x) => ({
        id: String(x.timedTextTrackId ?? x.trackGroupId ?? `${x.languageCode}-${x.type}-${x.subtype ?? ''}`),
        lang: String(x.languageCode ?? 'und'),
        label: String(x.displayName ?? x.languageCode ?? 'Subtitles'),
        cc: x.type === 'sdh' || /sdh|cc/i.test(String(x.subtype ?? '')),
        forced: !!x.forced || x.type === 'forced' || x.type === 'narrative',
        url: x.url as string,
      }));
  }

  // ------------------------------------------------------------------ YouTube
  interface YtPlayer extends HTMLElement {
    getPlayerResponse?: () => Json;
    setOption?: (module: string, option: string, value: unknown) => void;
    loadModule?: (m: string) => void;
    getVideoData?: () => { video_id: string };
  }

  function ytCompact(pr: Json | null | undefined) {
    if (!pr) return null;
    const details = pr.videoDetails as Json | undefined;
    const tl = ((pr.captions as Json | undefined)?.playerCaptionsTracklistRenderer ?? {}) as Json;
    const name = (n: Json | undefined) =>
      (n?.simpleText as string) ?? ((n?.runs as Json[] | undefined)?.map((r) => r.text).join('') || '');
    return {
      videoId: String(details?.videoId ?? ''),
      title: String(details?.title ?? ''),
      tracks: ((tl.captionTracks as Json[] | undefined) ?? []).map((t) => ({
        baseUrl: String(t.baseUrl),
        lang: String(t.languageCode),
        label: name(t.name as Json) || String(t.languageCode),
        kind: (t.kind as string) ?? '',
        vssId: (t.vssId as string) ?? '',
        translatable: !!t.isTranslatable,
      })),
      translationLanguages: ((tl.translationLanguages as Json[] | undefined) ?? []).map((l) => String(l.languageCode)),
    };
  }

  function ytPlayer(): YtPlayer | null {
    return (document.getElementById('movie_player') as YtPlayer | null) ?? null;
  }

  function ytCurrent() {
    const p = ytPlayer();
    let pr: Json | null = null;
    try {
      pr = p?.getPlayerResponse?.() ?? null;
    } catch {
      /* ignore */
    }
    if (!pr) pr = ((window as unknown as Json).ytInitialPlayerResponse as Json) ?? null;
    return ytCompact(pr);
  }

  if (isYouTube) {
    const announce = () => {
      const c = ytCurrent();
      if (c?.videoId) post('yt:player', c);
    };
    document.addEventListener('yt-navigate-finish', () => setTimeout(announce, 300));
    document.addEventListener('yt-page-data-updated', () => setTimeout(announce, 300));
    window.addEventListener('DOMContentLoaded', () => setTimeout(announce, 500));
  }

  // ------------------------------------------------------------------ requests from the isolated world
  window.addEventListener('message', async (ev: MessageEvent) => {
    const d = ev.data as { [TAG]?: string; type?: string; id?: string; payload?: Json } | null;
    if (ev.source !== window || !d || d[TAG] !== 'i2m' || !d.id) return;
    const reply = (ok: boolean, result: unknown) => post('reply', { ok, result }, d.id);
    try {
      switch (d.type) {
        case 'fetch': {
          const res = await origFetch(String(d.payload?.url), { credentials: 'include' });
          reply(true, { status: res.status, text: await res.text() });
          break;
        }
        case 'netflix:seek': {
          const p = netflixPlayer();
          if (!p) throw new Error('Netflix player API not found');
          p.seek(Number(d.payload?.ms));
          reply(true, true);
          break;
        }
        case 'yt:playerResponse':
          reply(true, ytCurrent());
          break;
        case 'yt:enableCaptions': {
          const p = ytPlayer();
          if (!p?.setOption) throw new Error('YouTube player API not found');
          try {
            p.loadModule?.('captions');
          } catch {
            /* ignore */
          }
          const track: Json = { languageCode: d.payload?.lang };
          if (d.payload?.kind) track.kind = d.payload.kind;
          p.setOption('captions', 'track', track);
          reply(true, true);
          break;
        }
        default:
          reply(false, `unknown request ${d.type}`);
      }
    } catch (e) {
      reply(false, e instanceof Error ? e.message : String(e));
    }
  });
})();

export {};
