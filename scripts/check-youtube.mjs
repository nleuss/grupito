// Smoke test against the real YouTube (needs a normal connection: YouTube blocks datacenter IPs).
//   npm run build && node scripts/check-youtube.mjs [videoId]
// Prints whether YouTube served caption tracks and whether Vidioma loaded them.
import { createRequire } from 'node:module';
import os from 'node:os'; import path from 'node:path'; import { mkdtempSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const EXT = path.resolve('dist');
const SHOT = path.resolve('test-results/screenshots');
(await import('node:fs')).mkdirSync(SHOT, { recursive: true });
const id = process.argv[2] ?? 'arj7oStGLkU';
const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(os.tmpdir(), 'yt-')), {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 }, locale: 'en-US',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, ...(process.env.HTTPS_PROXY ? [`--proxy-server=${process.env.HTTPS_PROXY}`] : [])],
});
const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
await sw.evaluate(() => chrome.storage.sync.set({ settings: { targetLang: 'en', nativeLang: 'es', uiLang: 'es' } }));
for (const url of [`https://www.youtube.com/watch?v=${id}`]) {
  const page = await ctx.newPage();
  const tt = [];
  page.on('request', (r) => { if (r.url().includes('/api/timedtext')) tt.push(r.url().slice(0, 140)); });
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => ({ status: () => 'ERR ' + e.message.split('\n')[0] }));
  await page.waitForTimeout(10000);
  const info = await page.evaluate(() => {
    const pr = document.getElementById('movie_player')?.getPlayerResponse?.() ?? window.ytInitialPlayerResponse;
    return {
      finalUrl: location.href.slice(0, 120),
      blocked: /unusual traffic|not a robot/i.test(document.body?.innerText ?? ''),
      playability: pr?.playabilityStatus?.status ?? null,
      reason: pr?.playabilityStatus?.reason ?? null,
      captionTracks: (pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []).length,
      overlay: !!document.getElementById('vidioma-overlay'),
    };
  });
  info.verdict = info.blocked
    ? 'YouTube blocked this network (unusual traffic page)'
    : !info.captionTracks
      ? 'YouTube served no caption tracks for this video'
      : tt.length
        ? 'OK: caption tracks found and requested'
        : 'Caption tracks exist but no caption request was seen';
  console.log(url, '→ HTTP', res.status(), JSON.stringify(info), 'timedtext requests:', tt.length);
  await page.screenshot({ path: path.join(SHOT, url.includes('embed') ? 'real-youtube-embed.png' : 'real-youtube.png') });
  await page.close();
}
await ctx.close();
