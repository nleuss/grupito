// Mock web server for E2E tests: imitates the parts of Netflix / YouTube / Disney+ / Prime Video
// that the extension depends on (manifests, caption APIs, playlists), plus a mock speech-to-text API.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', 'fixtures');
const cacheDir = path.join(here, '..', '..', 'test-results', 'media');

/** 30 s test video (VP8 + Opus): color bars and a tone with pauses. */
export function ensureTestVideo() {
  const out = path.join(cacheDir, 'test.webm');
  if (existsSync(out)) return out;
  mkdirSync(cacheDir, { recursive: true });
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=30',
    '-f', 'lavfi', '-i', "sine=frequency=330:duration=30,volume='if(lt(mod(t,3),2),1,0)':eval=frame",
    '-c:v', 'libvpx', '-b:v', '400k', '-c:a', 'libopus', '-b:a', '64k', '-shortest', out,
  ]);
  return out;
}

function parseVtt(text) {
  return text
    .split(/\n\n+/)
    .slice(1)
    .map((b) => {
      const [timing, ...lines] = b.trim().split('\n');
      const [a, z] = timing.split('-->').map((s) => s.trim());
      const sec = (t) => t.split(':').reduce((acc, p) => acc * 60 + parseFloat(p), 0);
      return { start: sec(a), end: sec(z), text: lines.join('\n') };
    });
}

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;background:#111;color:#eee;font-family:sans-serif} video{display:block;background:#000}</style></head><body>${body}</body></html>`;

export function startServer() {
  const log = [];
  const sttRequests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const base = `http://${req.headers.host}`;
    log.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (code, type, body, extra = {}) => {
      res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', ...extra });
      res.end(body);
    };
    try {
      const p = url.pathname;
      if (p === '/media/test.webm') {
        const buf = await readFile(ensureTestVideo());
        const range = req.headers.range;
        if (range) {
          const [s, e] = range.replace('bytes=', '').split('-');
          const start = parseInt(s, 10);
          const end = e ? parseInt(e, 10) : buf.length - 1;
          res.writeHead(206, { 'Content-Type': 'video/webm', 'Content-Range': `bytes ${start}-${end}/${buf.length}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
          return res.end(buf.subarray(start, end + 1));
        }
        return send(200, 'video/webm', buf, { 'Accept-Ranges': 'bytes' });
      }
      if (p.startsWith('/subs/')) {
        const file = path.join(fixtures, 'subs', path.basename(p));
        const type = p.endsWith('.vtt') ? 'text/vtt' : p.endsWith('.srt') ? 'application/x-subrip' : 'application/ttml+xml';
        return send(200, `${type}; charset=utf-8`, await readFile(file));
      }

      // ---------------------------------------------------------- generic pages
      if (p === '/generic.html' || p === '/ja.html') {
        const lang = p === '/ja.html' ? 'ja' : 'en';
        return send(200, 'text/html', page('Generic mock', `<h3 style="margin:8px">Generic video page</h3>
<video id="v" src="/media/test.webm" style="width:960px;height:540px" muted preload="auto">
  <track src="/subs/${lang}.vtt" srclang="${lang}" kind="subtitles" label="${lang === 'ja' ? '日本語' : 'English'}">
</video>`));
      }

      // ---------------------------------------------------------- Netflix
      if (/^\/watch\/\d+$/.test(p)) {
        const id = Number(p.split('/').pop());
        const track = (lang, desc, type, fmt, file, idx) => ({
          language: lang,
          languageDescription: desc,
          rawTrackType: type,
          isNoneTrack: false,
          isForcedNarrative: false,
          new_track_id: `T:${idx}`,
          ttDownloadables: fmt === 'webvtt-lssdh-ios8' ? { [fmt]: { downloadUrls: { 1: `${base}/subs/${file}` } } } : { [fmt]: { urls: [{ url: `${base}/subs/${file}` }] } },
        });
        const manifest = { version: 2, result: { movieId: id, timedtexttracks: [
          track('en', 'English', 'subtitles', 'webvtt-lssdh-ios8', 'en.vtt', 1),
          track('es', 'Español', 'subtitles', 'webvtt-lssdh-ios8', 'es.vtt', 2),
          track('en', 'English', 'closedcaptions', 'dfxp-ls-sdh', 'en.ttml', 3),
          { isNoneTrack: true, language: 'none', new_track_id: 'T:none' },
        ] } };
        const next = { result: { movieId: id + 1, timedtexttracks: [track('fr', 'Français', 'subtitles', 'webvtt-lssdh-ios8', 'es.vtt', 9)] } };
        return send(200, 'text/html', page('Netflix mock', `<div class="watch-video"><div data-uia="video-title"><h4>Mock Show</h4><span>E1 Pilot</span></div>
<div class="player-timedtext">NATIVE NETFLIX SUBS</div>
<video id="v" src="/media/test.webm" style="width:960px;height:540px" muted preload="auto"></video></div>
<script>
  window.__manifestRequest = JSON.stringify({ version: 2, url: '/manifest', params: { type: 'standard', viewableId: ${id}, profiles: ['playready-h264mpl30-dash'] } });
  setTimeout(() => {
    JSON.parse(${JSON.stringify(JSON.stringify(manifest))});
    JSON.parse(${JSON.stringify(JSON.stringify(next) + ' '.repeat(600))});
  }, 300);
  window.__seeks = [];
  window.netflix = { appContext: { state: { playerApp: { getAPI: () => ({ videoPlayer: {
    getAllPlayerSessionIds: () => ['watch-session'],
    getVideoPlayerBySessionId: () => ({ seek: (ms) => { window.__seeks.push(ms); document.getElementById('v').currentTime = ms / 1000; } }),
  } }) } } } };
</script>`));
      }

      // ---------------------------------------------------------- YouTube
      if (p === '/youtube.html') {
        return send(200, 'text/html', page('Mock video - YouTube', `<div id="movie_player" style="width:960px;height:540px;position:relative">
<video class="html5-main-video" src="/media/test.webm" style="width:100%;height:100%" muted preload="auto"></video>
<div class="ytp-caption-window-container" style="position:absolute;bottom:10px;left:10px;color:#fff">NATIVE YT CAPTIONS</div></div>
<script>
  const pr = { videoDetails: { videoId: 'abc123', title: 'Mock YouTube video' }, captions: { playerCaptionsTracklistRenderer: {
    captionTracks: [
      { baseUrl: '/api/timedtext?v=abc123&lang=en&caps=asr&opi=1&signature=sig', languageCode: 'en', name: { simpleText: 'English' }, vssId: '.en', isTranslatable: true },
      { baseUrl: '/api/timedtext?v=abc123&lang=en&kind=asr&signature=sig', languageCode: 'en', kind: 'asr', name: { runs: [{ text: 'English (auto-generated)' }] }, vssId: 'a.en', isTranslatable: true },
    ],
    translationLanguages: [{ languageCode: 'es' }, { languageCode: 'fr' }] } } };
  window.ytInitialPlayerResponse = pr;
  const player = document.getElementById('movie_player');
  player.getPlayerResponse = () => pr;
  player.loadModule = () => {};
  player.setOption = (m, o, v) => {
    window.__setOption = v;
    fetch('/api/timedtext?v=abc123&lang=' + v.languageCode + (v.kind ? '&kind=' + v.kind : '') + '&fmt=json3&pot=POT123&c=WEB&cver=2.20240101');
  };
</script>`));
      }
      if (p === '/api/timedtext') {
        // Like YouTube today: no proof-of-origin token, no captions.
        if (!url.searchParams.get('pot')) return send(200, 'application/json', '');
        const cues = parseVtt(await readFile(path.join(fixtures, 'subs', 'en.vtt'), 'utf8'));
        const tlang = url.searchParams.get('tlang');
        const events = [{ tStartMs: 0, dDurationMs: 30000, id: 1, wWinId: 1 }];
        for (const c of cues) {
          events.push({ tStartMs: Math.round(c.start * 1000), dDurationMs: Math.round((c.end - c.start) * 1000), segs: [{ utf8: tlang ? `[yt-${tlang}] ${c.text}` : c.text }] });
          events.push({ tStartMs: Math.round(c.end * 1000), dDurationMs: 10, aAppend: 1, segs: [{ utf8: '\n' }] });
        }
        return send(200, 'application/json', JSON.stringify({ wireMagic: 'pb3', events }));
      }

      // ---------------------------------------------------------- Disney+
      if (p === '/disney.html') {
        return send(200, 'text/html', page('Disney+ mock', `<div class="title-field">Mock Disney Movie</div>
<video id="v" src="/media/test.webm" style="width:960px;height:540px" muted preload="auto"></video>
<script>setTimeout(() => fetch('/hls/master.m3u8').then((r) => r.text()), 200);</script>`));
      }
      if (p === '/hls/master.m3u8') {
        return send(200, 'application/vnd.apple.mpegurl', `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="en",NAME="English",URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="English",LANGUAGE="en",AUTOSELECT=YES,URI="subs/en/index.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="Español (Latinoamérica)",LANGUAGE="es-419",AUTOSELECT=YES,URI="subs/es/index.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub-forced",NAME="English",LANGUAGE="en",FORCED=YES,URI="subs/en/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2000000,SUBTITLES="sub",AUDIO="aac"
video/1.m3u8
`);
      }
      const hlsIdx = p.match(/^\/hls\/subs\/(en|es)\/index\.m3u8$/);
      if (hlsIdx) {
        return send(200, 'application/vnd.apple.mpegurl', `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg0.vtt\n#EXTINF:10.0,\nseg1.vtt\n#EXTINF:10.0,\nseg2.vtt\n#EXT-X-ENDLIST\n`);
      }
      const hlsSeg = p.match(/^\/hls\/subs\/(en|es)\/seg(\d)\.vtt$/);
      if (hlsSeg) {
        const cues = parseVtt(await readFile(path.join(fixtures, 'subs', `${hlsSeg[1]}.vtt`), 'utf8'));
        const n = Number(hlsSeg[2]);
        // Each 10 s segment carries the cues overlapping it (boundary cues are repeated, like real HLS).
        const inSeg = cues.filter((c) => c.end > n * 10 && c.start < (n + 1) * 10);
        const ts = (s) => new Date(s * 1000).toISOString().slice(11, 23);
        const body = `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n${inSeg.map((c) => `${ts(c.start)} --> ${ts(c.end)}\n${c.text}`).join('\n\n')}\n`;
        return send(200, 'text/vtt', body);
      }

      // ---------------------------------------------------------- Prime Video
      if (p === '/prime.html') {
        return send(200, 'text/html', page('Prime mock', `<div class="webPlayerSDKContainer"><div class="rendererContainer">
<video id="v" src="/media/test.webm" style="width:960px;height:540px" muted preload="auto"></video></div></div>
<script>setTimeout(() => fetch('/cdp/catalog/GetPlaybackResources?asin=amzn1.dv.gti.MOCK&desiredResources=PlaybackUrls,SubtitleUrls').then((r) => r.json()), 200);</script>`));
      }
      if (p === '/cdp/catalog/GetPlaybackResources') {
        return send(200, 'application/json', JSON.stringify({
          catalogMetadata: { catalog: { title: 'Prime Mock Title' } },
          timedTextUrls: { result: {
            subtitleUrls: [
              { url: `${base}/subs/en.ttml`, languageCode: 'en-us', displayName: 'English', type: 'subtitle', timedTextTrackId: 'en-sub' },
              { url: `${base}/subs/es.dfxp`, languageCode: 'es-es', displayName: 'Español', type: 'subtitle', timedTextTrackId: 'es-sub' },
            ],
            forcedNarratives: [{ url: `${base}/subs/en.ttml`, languageCode: 'en-us', displayName: 'English [Forced]', type: 'forced', timedTextTrackId: 'en-forced' }],
          } },
        }));
      }

      // ---------------------------------------------------------- mock speech-to-text
      if (p === '/stt/audio/transcriptions' && req.method === 'POST') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks).toString('latin1');
        const field = (name) => body.match(new RegExp(`name="${name.replace(/[[\]]/g, '\\$&')}"\\r\\n\\r\\n([^\\r]*)`))?.[1];
        sttRequests.push({ model: field('model'), format: field('response_format'), language: field('language'), bytes: body.length, auth: req.headers.authorization });
        return send(200, 'application/json', JSON.stringify({
          text: 'Hello from the mock transcriber. This is the second line.',
          segments: [
            { start: 1, end: 3, text: ' Hello from the mock transcriber.', no_speech_prob: 0.01, avg_logprob: -0.2 },
            { start: 4, end: 6, text: ' This is the second line.', no_speech_prob: 0.02, avg_logprob: -0.3 },
            { start: 7, end: 8, text: ' Thanks for watching!', no_speech_prob: 0.9, avg_logprob: -1.5 },
          ],
        }));
      }
      send(404, 'text/plain', 'not found');
    } catch (e) {
      send(500, 'text/plain', String(e?.stack ?? e));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, base: `http://127.0.0.1:${port}`, log, sttRequests, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
