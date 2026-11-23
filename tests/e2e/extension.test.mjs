// End-to-end tests: load the test build (dist-test/) into Chromium and drive mock sites.
// Run with: npm run test:e2e   (set VIDIOMA_ANKI_PYTHON=/path/to/python-with-anki to verify .apkg import)
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureTestVideo, startServer } from './server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = path.join(root, 'dist-test');
const OUT = path.join(root, 'test-results');
const SHOTS = path.join(OUT, 'screenshots');
mkdirSync(SHOTS, { recursive: true });

let ctx;
let sw;
let extId;
let srv;

async function setSettings(patch) {
  await sw.evaluate(async (p) => {
    const cur = (await chrome.storage.sync.get('settings')).settings ?? {};
    await chrome.storage.sync.set({ settings: { ...cur, ...p } });
  }, patch);
}

async function vocab() {
  return sw.evaluate(async () => Object.entries(await chrome.storage.local.get(null)).filter(([k]) => k.startsWith('vocab:')).map(([, v]) => v));
}

async function openVideoPage(url) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_FILE_NOT_FOUND|404/.test(m.text()) && console.log('[console]', m.text()));
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 1, null, { timeout: 15000 });
  await page.waitForSelector('#vidioma-overlay', { state: 'attached', timeout: 15000 });
  return page;
}

async function seek(page, t) {
  await page.evaluate((time) => {
    const v = document.querySelector('video');
    v.pause();
    v.currentTime = time;
  }, t);
}

const text = (page, sel, hasText, timeout = 10000) => page.locator(sel, { hasText }).first().waitFor({ timeout });
const videoTime = (page) => page.evaluate(() => document.querySelector('video').currentTime);

before(async () => {
  assert.ok(existsSync(path.join(EXT, 'manifest.json')), 'run "npm run build:test" first');
  ensureTestVideo();
  srv = await startServer();
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'vidioma-e2e-'));
  ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 760 },
    acceptDownloads: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required', '--no-proxy-server'],
  });
  sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  extId = new URL(sw.url()).host;
  await setSettings({ targetLang: 'en', nativeLang: 'es', translationProvider: 'mock', uiLang: 'en', autoPause: false, pauseOnWordClick: true });
});

after(async () => {
  await ctx?.close();
  await srv?.close();
});

describe('Vidioma extension', () => {
  test('generic page: dual subtitles, word card, save, explain, line navigation', async () => {
    const page = await openVideoPage(`${srv.base}/generic.html`);
    await seek(page, 1.5);
    await text(page, '.vd-primary', 'Hello there, how are you today?');
    await text(page, '.vd-trans', '[es] Hello there, how are you today?');

    await seek(page, 4.5);
    await text(page, '.vd-primary', 'I am learning Spanish with movies.');
    await page.locator('.vd-w', { hasText: /^learning$/ }).click();
    await text(page, '.vd-pop-word', 'learning');
    await text(page, '.vd-pop-tr', '[es] learning');
    await page.locator('.vd-btn.vd-ai').click();
    await text(page, '.vd-explain', 'Meaning of learning');
    await page.screenshot({ path: path.join(SHOTS, 'generic-word-card.png') });
    await page.locator('.vd-pop button[title="Save"]').click();
    await text(page, '.vd-toast', 'Saved to your vocabulary');

    const items = await vocab();
    const saved = items.find((v) => v.text === 'learning');
    assert.ok(saved, 'word saved');
    assert.equal(saved.context, 'I am learning Spanish with movies.');
    assert.equal(saved.contextTranslation, '[es] I am learning Spanish with movies.');
    assert.equal(saved.translation, '[es] learning');
    assert.equal(saved.source.site, 'generic');
    assert.ok(Math.abs(saved.source.time - 4) < 0.1);

    await page.keyboard.press('Escape');
    await page.locator('.vd-pop').waitFor({ state: 'detached' });
    await page.locator('.vd-w.vd-saved', { hasText: /^learning$/ }).waitFor();

    await page.keyboard.press('d');
    await page.waitForFunction(() => Math.abs(document.querySelector('video').currentTime - 7.02) < 0.3);
    await page.evaluate(() => document.querySelector('video').pause());
    await text(page, '.vd-primary', 'The weather is beautiful this morning.');
    await page.keyboard.press('a');
    await page.waitForFunction(() => Math.abs(document.querySelector('video').currentTime - 4.02) < 0.3);
    await page.evaluate(() => document.querySelector('video').pause());

    // Auto-pause: playback stops at the end of the line.
    await setSettings({ autoPause: true });
    await seek(page, 9.6);
    await page.evaluate(() => document.querySelector('video').play());
    await text(page, '.vd-primary', 'Would you like a cup of coffee?');
    await page.waitForFunction(() => document.querySelector('video').paused, null, { timeout: 8000 });
    const t = await videoTime(page);
    assert.ok(t > 12.2 && t < 12.6, `auto-paused at end of line (t=${t})`);
    await setSettings({ autoPause: false });
    await page.close();
  });

  test('Netflix mock: manifest capture, official translation track, player-API seeking', async () => {
    const page = await openVideoPage(`${srv.base}/watch/80000001?vidioma_site=netflix`);
    await seek(page, 10.5);
    await text(page, '.vd-primary', 'Would you like a cup of coffee?');
    await text(page, '.vd-trans', '¿Te apetece una taza de café?');

    const req = await page.evaluate(() => window.__manifestRequest);
    assert.match(req, /webvtt-lssdh-ios8/);
    assert.match(req, /"showAllSubDubTracks":true/);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.player-timedtext')).visibility), 'hidden');

    const labels = await page.locator('.vd-sel select').first().locator('option').allTextContents();
    assert.deepEqual(labels, ['English', 'Español', 'English [CC]']);

    await page.keyboard.press('d');
    await page.waitForFunction(() => window.__seeks.length > 0);
    const seeks = await page.evaluate(() => window.__seeks);
    assert.ok(Math.abs(seeks[0] - 13020) < 50, `seek through player API (${seeks[0]})`);
    await page.mouse.move(700, 300);
    await page.screenshot({ path: path.join(SHOTS, 'netflix-mock.png') });
    await page.close();
  });

  test('YouTube mock: proof-of-origin token reuse and YouTube auto-translate', async () => {
    const page = await openVideoPage(`${srv.base}/youtube.html?v=abc123&vidioma_site=youtube`);
    await seek(page, 13.5);
    await text(page, '.vd-primary', "Let's go to the beach tomorrow.");
    await text(page, '.vd-trans', "[yt-es] Let's go to the beach tomorrow.");
    const tt = srv.log.filter((l) => l.includes('/api/timedtext'));
    assert.ok(tt.some((l) => !l.includes('pot=')), 'tried without token first');
    assert.ok(tt.some((l) => l.includes('pot=POT123') && !l.includes('tlang')), 'player fetched with token');
    assert.ok(tt.some((l) => l.includes('pot=POT123') && l.includes('tlang=es')), 'reused token for translation');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.ytp-caption-window-container')).display), 'none');
    await page.close();
  });

  test('Disney+ mock: HLS WebVTT segments merged without duplicates', async () => {
    const page = await openVideoPage(`${srv.base}/disney.html?vidioma_site=disney`);
    await seek(page, 20.5);
    await text(page, '.vd-primary', 'Can you speak more slowly, please?');
    await text(page, '.vd-trans', '¿Puedes hablar más despacio, por favor?');
    await page.keyboard.press('g');
    await page.locator('.vd-tr-row').first().waitFor();
    assert.equal(await page.locator('.vd-tr-row').count(), 9);
    await page.screenshot({ path: path.join(SHOTS, 'disney-transcript.png') });
    await page.close();
  });

  test('Prime Video mock: TTML/DFXP tracks, forced narrative not auto-selected', async () => {
    const page = await openVideoPage(`${srv.base}/prime.html?vidioma_site=prime`);
    await seek(page, 16.5);
    await text(page, '.vd-primary', "I don't understand this word.");
    await text(page, '.vd-trans', 'No entiendo esta palabra.');
    const selected = await page.locator('.vd-sel select').first().evaluate((s) => s.options[s.selectedIndex].text);
    assert.equal(selected, 'English');
    await page.close();
  });

  test('Japanese: furigana and romaji from kuromoji in the offscreen document', async () => {
    await setSettings({ targetLang: 'ja', romanizationLine: true });
    try {
      const page = await openVideoPage(`${srv.base}/ja.html`);
      await seek(page, 1.5);
      await page.locator('.vd-primary rt', { hasText: 'わたし' }).waitFor({ timeout: 20000 });
      await text(page, '.vd-roman', 'watashi wa nihongo o benkyou shi te i masu');
      await page.locator('.vd-w', { hasText: '勉強' }).click();
      await text(page, '.vd-pop-word', '勉強');
      await text(page, '.vd-pop-reading', 'べんきょう');
      await page.screenshot({ path: path.join(SHOTS, 'japanese-furigana.png') });
      await page.close();
    } finally {
      await setSettings({ targetLang: 'en', romanizationLine: false });
    }
  });

  test('vocabulary page: CSV and .apkg export', async () => {
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extId}/pages/vocab.html`);
    await text(page, '.vocab .w', 'learning');
    await page.screenshot({ path: path.join(SHOTS, 'vocab-page.png'), fullPage: true });

    const [csvDl] = await Promise.all([page.waitForEvent('download'), page.getByText('Export CSV').click()]);
    const csvPath = path.join(OUT, 'vocab.csv');
    await csvDl.saveAs(csvPath);
    const csv = readFileSync(csvPath, 'utf8');
    assert.match(csv, /^﻿text,kind,language,translation/);
    assert.match(csv, /learning,word,en,\[es\] learning/);

    const [apkgDl] = await Promise.all([page.waitForEvent('download'), page.getByText('Export Anki deck (.apkg)').click()]);
    const apkgPath = path.join(OUT, 'vocab.apkg');
    await apkgDl.saveAs(apkgPath);
    verifyApkg(apkgPath, { notes: 1, firstWord: 'learning', media: 0 });
    await page.close();
  });

  test('local player: subtitle files, AI transcription (mock STT), Anki deck with audio + screenshots', async () => {
    await setSettings({ sttBaseUrl: `${srv.base}/stt`, sttModel: 'whisper-1' });
    await sw.evaluate(async () => chrome.storage.local.set({ secrets: { claudeKey: '', deeplKey: '', sttKey: 'test-key' } }));
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('[player pageerror]', e.message));
    await page.goto(`chrome-extension://${extId}/pages/player.html`);
    await page.locator('label.btn.primary input[type=file]').setInputFiles(ensureTestVideo());
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 1);

    const pick = async (button, file) => {
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: button }).click()]);
      await chooser.setFiles(path.join(root, 'tests/fixtures/subs', file));
    };
    await pick('Subtitles…', 'en.srt');
    await pick('Translation…', 'es.srt');
    await seek(page, 4.5);
    await text(page, '.vd-primary', 'I am learning Spanish with movies.');
    await text(page, '.vd-trans', 'Estoy aprendiendo español con películas.');
    assert.equal(await page.locator('.vd-tr-row').count(), 9);
    await page.locator('.vd-tr-row').nth(6).click();
    assert.ok(Math.abs((await videoTime(page)) - 19.02) < 0.3, 'transcript click seeks');
    await page.evaluate(() => document.querySelector('video').pause());
    await page.screenshot({ path: path.join(SHOTS, 'player.png') });

    await page.getByRole('button', { name: /Transcribe with AI/ }).click();
    await page.getByRole('button', { name: /Transcribe with AI/ }).waitFor({ timeout: 30000 });
    assert.ok(srv.sttRequests.length >= 1, 'speech-to-text called');
    assert.deepEqual(
      { model: srv.sttRequests[0].model, format: srv.sttRequests[0].format, language: srv.sttRequests[0].language, auth: srv.sttRequests[0].auth },
      { model: 'whisper-1', format: 'verbose_json', language: 'en', auth: 'Bearer test-key' },
    );
    const primary = page.locator('.controls select').first();
    await primary.selectOption({ label: 'AI captions' });
    await text(page, '.vd-tr-row', 'Hello from the mock transcriber.');
    assert.equal(await page.locator('.vd-tr-row', { hasText: 'Thanks for watching' }).count(), 0, 'hallucination filtered');
    await primary.selectOption({ label: 'en.srt' });
    await text(page, '.vd-tr-row', 'See you later, my friend.');

    await page.getByRole('button', { name: 'Create Anki deck' }).click();
    const [deckDl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.getByRole('button', { name: 'Build deck' }).click()]);
    const deckPath = path.join(OUT, 'player-deck.apkg');
    await deckDl.saveAs(deckPath);
    verifyApkg(deckPath, { notes: 9, firstWord: 'Hello there, how are you today?', media: 18, meaning: 'Hola, ¿cómo estás hoy?' });
    await page.close();
  });

  test('settings and popup pages render', async () => {
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extId}/pages/options.html`);
    await text(page, 'h2', 'Languages');
    await page.screenshot({ path: path.join(SHOTS, 'options.png'), fullPage: true });
    await page.goto(`chrome-extension://${extId}/pages/popup.html`);
    await page.setViewportSize({ width: 380, height: 560 });
    await text(page, '.popup', "I'm learning");
    await page.screenshot({ path: path.join(SHOTS, 'popup.png') });
    await page.close();
  });
});

function verifyApkg(file, expect) {
  // Structural check with unzip + sqlite3 (always), then a real import with Anki's library when available.
  const py = process.env.VIDIOMA_ANKI_PYTHON;
  if (!py) {
    console.log('  (skipping Anki import check: set VIDIOMA_ANKI_PYTHON)');
    return;
  }
  const out = execFileSync(py, [path.join(root, 'tests/e2e/verify_apkg.py'), file], { encoding: 'utf8' });
  const summary = JSON.parse(out.trim().split('\n').pop());
  assert.equal(summary.notes, expect.notes, 'notes imported');
  assert.equal(summary.cards, expect.notes, 'cards imported');
  assert.ok(summary.models.includes('Vidioma'), 'note type imported');
  assert.equal(summary.first.Word, expect.firstWord);
  if (expect.meaning) assert.equal(summary.first.Meaning, expect.meaning);
  assert.equal(summary.media_files, expect.media, 'media files imported');
}
