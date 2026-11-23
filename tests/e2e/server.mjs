// Mock web server for E2E tests: imitates the parts of YouTube and Netflix
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
  window.__manifestRequest = JSON.stringify({ version: 2, url: 'licensedManifest', id: 1700000000000, languages: ['en-US'], params: { type: 'standard', viewableId: ${id}, profiles: ['playready-h264mpl30-dash', 'heaac-2-dash'], showAllSubDubTracks: false } });
  setTimeout(() => {
    JSON.parse(${JSON.stringify(JSON.stringify(manifest))});
    JSON.parse(${JSON.stringify(JSON.stringify(next) + ' '.repeat(600))});
  }, 300);
  window.__seeks = [];
  window.__playerCalls = [];
  const v = () => document.getElementById('v');
  window.netflix = { appContext: { state: { playerApp: { getAPI: () => ({ videoPlayer: {
    getAllPlayerSessionIds: () => ['watch-session'],
    getVideoPlayerBySessionId: () => ({
      seek: (ms) => { window.__seeks.push(ms); v().currentTime = ms / 1000; },
      play: () => { window.__playerCalls.push('play'); v().play().catch(() => {}); },
      pause: () => { window.__playerCalls.push('pause'); v().pause(); },
    }),
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
  // What YouTube's player does: request the selected track with its token and client parameters.
  const requestCaptions = (lang, kind) => fetch('/api/timedtext?v=abc123&ei=EIX&caps=asr&opi=1&exp=xpe&xoaf=5&hl=en&ip=0.0.0.0&ipbits=0&expire=9999999999&sparams=ip,ipbits,expire,v,caps,opi,exp,xoaf&signature=sig&key=yt8&lang=' + lang + (kind ? '&kind=' + kind : '') + '&fmt=json3&xorb=2&xobt=3&xovt=3&cbr=Chrome&cbrver=131&c=WEB&cver=2.20241120&cplayer=UNIPLAYER&cos=X11&cplatform=DESKTOP&potc=1&pot=POT123');
  const buttonOnly = new URLSearchParams(location.search).get('cc') === 'button';
  player.setOption = (m, o, v) => { window.__setOption = v; if (!buttonOnly) requestCaptions(v.languageCode, v.kind); };
  const cc = document.createElement('button');
  cc.className = 'ytp-subtitles-button';
  cc.setAttribute('aria-pressed', 'false');
  cc.textContent = 'CC';
  cc.onclick = () => { cc.setAttribute('aria-pressed', 'true'); window.__ccClicked = true; requestCaptions('en'); };
  player.appendChild(cc);
</script>`));
      }
      if (p === '/api/timedtext') {
        // Like YouTube today: without the player's proof-of-origin token (and client params), no captions.
        if (!url.searchParams.get('pot') || url.searchParams.get('xorb') !== '2' || url.searchParams.get('c') !== 'WEB') return send(200, 'application/json', '');
        const cues = parseVtt(await readFile(path.join(fixtures, 'subs', 'en.vtt'), 'utf8'));
        const tlang = url.searchParams.get('tlang');
        const asr = url.searchParams.get('kind') === 'asr';
        const events = [{ tStartMs: 0, dDurationMs: 30000, id: 1, wWinId: 1, wsWinStyleId: 1 }];
        for (const c of cues) {
          const ms = (s) => Math.round(s * 1000);
          if (asr) {
            // Auto-captions: a few words at a time, each line staying up while the next one types out.
            const words = c.text.split(' ');
            const half = Math.ceil(words.length / 2);
            const mid = c.start + (c.end - c.start) / 2;
            events.push({ tStartMs: ms(c.start), dDurationMs: ms(c.end - c.start), wWinId: 1, segs: words.slice(0, half).map((w, i) => ({ utf8: (i ? ' ' : '') + w, tOffsetMs: i * 150, acAsrConf: 200 })) });
            events.push({ tStartMs: ms(mid), dDurationMs: ms(c.end - c.start), wWinId: 1, segs: words.slice(half).map((w, i) => ({ utf8: (i ? ' ' : '') + w, tOffsetMs: i * 150, acAsrConf: 200 })) });
          } else {
            events.push({ tStartMs: ms(c.start), dDurationMs: ms(c.end - c.start), segs: [{ utf8: tlang ? `[yt-${tlang}] ${c.text}` : c.text }] });
          }
          events.push({ tStartMs: ms(c.end), dDurationMs: 10, aAppend: 1, segs: [{ utf8: '\n' }] });
        }
        return send(200, 'application/json', JSON.stringify({ wireMagic: 'pb3', events }));
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
