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

  test('Netflix mock: manifest capture, official translation track, player-API seek/play/pause', async () => {
    const page = await openVideoPage(`${srv.base}/watch/80000001?vidioma_site=netflix`);
    await seek(page, 10.5);
    await text(page, '.vd-primary', 'Would you like a cup of coffee?');
    await text(page, '.vd-trans', '¿Te apetece una taza de café?');

    const req = JSON.parse(await page.evaluate(() => window.__manifestRequest));
    for (const p of ['webvtt-lssdh-ios8', 'dfxp-ls-sdh', 'imsc1.1']) assert.ok(req.params.profiles.includes(p), `requested ${p}`);
    assert.ok(req.params.profiles.includes('playready-h264mpl30-dash'), 'kept the player profiles');
    assert.equal(req.params.showAllSubDubTracks, true);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.player-timedtext')).visibility), 'hidden');

    const labels = await page.locator('.vd-sel select').first().locator('option').allTextContents();
    assert.deepEqual(labels, ['English', 'Español', 'English [CC]'], 'next-episode manifest ignored');

    await page.keyboard.press('d');
    await page.waitForFunction(() => window.__seeks.length > 0);
    const seeks = await page.evaluate(() => window.__seeks);
    assert.ok(Math.abs(seeks[0] - 13020) < 50, `seek through player API (${seeks[0]})`);

    // Clicking a word pauses through Netflix's player API; closing the card resumes it.
    await seek(page, 16.2);
    await page.evaluate(() => document.querySelector('video').play());
    await page.locator('.vd-w', { hasText: /^understand$/ }).click();
    await text(page, '.vd-pop-word', 'understand');
    await page.waitForFunction(() => window.__playerCalls.includes('pause'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__playerCalls.includes('play'));
    await page.evaluate(() => document.querySelector('video').pause());
    await page.mouse.move(700, 300);
    await page.screenshot({ path: path.join(SHOTS, 'netflix-mock.png') });
    await page.close();
  });

  test('YouTube mock: reuses the player caption request (token + client params) and YouTube auto-translate', async () => {
    const page = await openVideoPage(`${srv.base}/youtube.html?v=abc123&vidioma_site=youtube`);
    await seek(page, 13.5);
    await text(page, '.vd-primary', "Let's go to the beach tomorrow.");
    await text(page, '.vd-trans', "[yt-es] Let's go to the beach tomorrow.");
    const tt = srv.log.filter((l) => l.includes('/api/timedtext'));
    assert.ok(tt.some((l) => !l.includes('pot=')), 'tried the plain caption URL first');
    assert.ok(tt.some((l) => l.includes('pot=POT123') && !l.includes('tlang')), 'player fetched with its token');
    const translated = tt.find((l) => l.includes('tlang=es'));
    assert.ok(translated, 'requested YouTube auto-translate');
    for (const p of ['pot=POT123', 'xorb=2', 'c=WEB', 'cplayer=UNIPLAYER', 'lang=en', 'fmt=json3']) assert.ok(translated.includes(p), `translation request kept ${p}`);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.ytp-caption-window-container')).display), 'none');

    // Ads play in the same <video>: subtitles disappear while YouTube marks the player with "ad-showing".
    await page.evaluate(() => document.getElementById('movie_player').classList.add('ad-showing'));
    await page.locator('.vd-primary').waitFor({ state: 'detached' });
    await page.evaluate(() => document.getElementById('movie_player').classList.remove('ad-showing'));
    await text(page, '.vd-primary', "Let's go to the beach tomorrow.");
    await page.close();
  });

  test('YouTube mock: auto-generated captions are merged into whole sentences', async () => {
    const page = await openVideoPage(`${srv.base}/youtube.html?v=abc123&vidioma_site=youtube`);
    await seek(page, 4.5);
    await text(page, '.vd-primary', 'I am learning Spanish with movies.');
    await page.locator('.vd-sel select').first().selectOption({ label: 'English (auto-generated) (auto)' });
    await seek(page, 2.8);
    await text(page, '.vd-primary', 'Hello there, how are you today?');
    await page.keyboard.press('g');
    await page.locator('.vd-tr-row').first().waitFor();
    assert.equal(await page.locator('.vd-tr-row').count(), 9, 'fragments merged back into 9 sentences');
    const transSel = await page.locator('.vd-sel select').nth(1).evaluate((s) => s.value);
    assert.equal(transSel, 'machine', 'auto-captions use machine translation of whole sentences');
    await text(page, '.vd-trans', '[es] Hello there, how are you today?');
    await page.close();
  });

  test('YouTube mock: falls back to pressing CC when the player API does not load captions', async () => {
    const page = await openVideoPage(`${srv.base}/youtube.html?v=abc123&vidioma_site=youtube&cc=button`);
    await seek(page, 7.5);
    await text(page, '.vd-primary', 'The weather is beautiful this morning.', 25000);
    assert.equal(await page.evaluate(() => window.__ccClicked), true);
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

// ---------------------------------------------------------------- book reader

const BOOK_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
  body { font-family: Georgia, serif; font-size: 13pt; line-height: 1.5; width: 10cm; text-align: justify; }
  h1 { font-size: 28pt; } h2 { font-size: 20pt; page-break-before: always; }
  p { margin: 0 0 0.7em; text-indent: 1.4em; }
</style></head><body>
<h1>Alice in Testland</h1>
<h2>Chapter One</h2>
${Array.from({ length: 7 }, (_, i) => `<p>Alice was beginning to get very tired of sitting by her sister on the bank, and of having nothing to do (paragraph ${i + 1}). Suddenly a white rabbit with pink eyes ran close by her, which was extra&shy;ordi&shy;narily curious, and she wondered what the rabbit could possibly be late for.</p>`).join('\n')}
<h2>Chapter Two</h2>
${Array.from({ length: 6 }, (_, i) => `<p>The pool of tears was much larger than Alice expected (part ${i + 1}), and the mouse that swam beside her seemed offended by every word she said about cats and dogs.</p>`).join('\n')}
</body></html>`;

async function makeBookPdf() {
  const file = path.join(OUT, 'book.pdf');
  const page = await ctx.newPage();
  await page.setContent(BOOK_HTML);
  await page.pdf({
    path: file,
    format: 'A5',
    outline: true,
    tagged: true,
    displayHeaderFooter: true,
    headerTemplate: '<div style="font-size:8px;width:100%;text-align:center">Alice in Testland - running header</div>',
    footerTemplate: '<div style="font-size:8px;width:100%;text-align:center"><span class="pageNumber"></span></div>',
    margin: { top: '1.6cm', bottom: '1.6cm', left: '1.2cm', right: '1.2cm' },
  });
  await page.close();
  return file;
}

async function makeBookEpub() {
  const { zipSync, strToU8 } = require('fflate');
  const xhtml = (title, body) => `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body>${body}</body></html>`;
  const data = zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'OEBPS/content.opf': strToU8(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>El cuento de prueba</dc:title><dc:creator>Ana Autora</dc:creator><dc:language>en</dc:language></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`),
    'OEBPS/nav.xhtml': strToU8(xhtml('TOC', '<nav><ol><li><a href="ch1.xhtml">First Part</a></li><li><a href="ch2.xhtml">Second Part</a></li></ol></nav>')),
    'OEBPS/ch1.xhtml': strToU8(xhtml('1', '<h1>First Part</h1><p>The lighthouse keeper polished the great lamp every evening.</p>')),
    'OEBPS/ch2.xhtml': strToU8(xhtml('2', '<h1>Second Part</h1><p>A storm arrived from the north before dawn.</p>')),
  });
  const file = path.join(OUT, 'book.epub');
  (await import('node:fs')).writeFileSync(file, data);
  return file;
}

describe('book reader', () => {
  test('PDF: chapters from the outline, clean paragraphs, word card, book-aware AI, translations, saved progress', async () => {
    await setSettings({ targetLang: 'en', nativeLang: 'es', translationProvider: 'mock' });
    const pdf = await makeBookPdf();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('[reader pageerror]', e.message));
    await page.goto(`chrome-extension://${extId}/pages/reader.html`);
    await page.locator('label.btn.primary input[type=file]').setInputFiles(pdf);
    await page.locator('.rd-main .rd-p').first().waitFor({ timeout: 30000 });

    const toc = await page.locator('.toc').allTextContents();
    assert.ok(toc.includes('Chapter One') && toc.includes('Chapter Two'), `chapters from the PDF outline: ${JSON.stringify(toc)}`);
    await page.locator('.toc', { hasText: 'Chapter One' }).click();
    await text(page, '.rd-text', 'Alice was beginning to get very tired');
    const paragraphs = await page.locator('.rd-main .rd-text').allTextContents();
    const body = paragraphs.filter((p) => p.startsWith('Alice was beginning'));
    assert.equal(body.length, 7, `7 paragraphs rebuilt (got ${body.length})`);
    assert.ok(body.every((p) => p.includes('extraordinarily curious')), 'soft hyphens / line-break hyphens removed');
    assert.ok(!paragraphs.some((p) => p.includes('running header')), 'running header removed');
    assert.ok(!paragraphs.some((p) => /^\d+$/.test(p.trim())), 'page numbers removed');

    // Word card with dictionary lookup, then the book-aware explanation.
    await page.locator('.rd-w', { hasText: /^rabbit$/ }).first().click();
    await text(page, '.vd-pop-word', 'rabbit');
    await text(page, '.vd-pop-tr', '[es] rabbit');
    await page.locator('.vd-btn.vd-ai').click();
    await text(page, '.vd-explain', 'Book meaning of rabbit');
    await page.screenshot({ path: path.join(SHOTS, 'reader-word-card.png') });
    await page.locator('.vd-pop button[title="Save"]').click();
    await text(page, '.toast', 'Saved to your vocabulary');
    const savedWord = (await vocab()).find((v) => v.text === 'rabbit' && v.source?.site === 'book');
    assert.ok(savedWord, 'saved with the book as source');
    assert.match(savedWord.source.location, /Chapter One · ¶\d+/);
    assert.ok(savedWord.context.includes('white rabbit with pink eyes'), 'sentence saved as context');
    await page.keyboard.press('Escape');

    // Paragraph translations.
    await page.getByLabel('Translations').check();
    await text(page, '.rd-tr', '[es] Alice was beginning to get very tired');

    // Whole-book analysis (mocked Claude in the test build).
    await page.getByRole('button', { name: /About the book/ }).click();
    await page.getByRole('button', { name: /Analyse the whole book with AI/ }).click();
    await text(page, '.rd-about', 'Mock premise of');
    await text(page, '.rd-about dt', 'mome raths');
    await page.screenshot({ path: path.join(SHOTS, 'reader-about.png') });

    // Progress is remembered.
    await page.locator('.toc', { hasText: 'Chapter Two' }).click();
    await text(page, '.rd-section-title', 'Chapter Two');
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(1200);
    await page.reload();
    await text(page, '.book-title', 'Alice in Testland');
    await page.getByRole('button', { name: 'Continue' }).first().click();
    await text(page, '.rd-section-title', 'Chapter Two');
    await page.close();
  });

  test('EPUB: metadata, table of contents and paragraphs', async () => {
    const epub = await makeBookEpub();
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extId}/pages/reader.html`);
    await page.locator('label.btn.primary input[type=file]').setInputFiles(epub);
    await page.locator('.rd-main .rd-p').first().waitFor({ timeout: 15000 });
    assert.deepEqual(await page.locator('.toc').allTextContents(), ['First Part', 'Second Part']);
    await text(page, '.rd-text', 'The lighthouse keeper polished the great lamp every evening.');
    await page.getByRole('button', { name: /Next/ }).click();
    await text(page, '.rd-text', 'A storm arrived from the north before dawn.');
    await page.close();
  });
});
