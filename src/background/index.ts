// Service worker: message router, network access, AI captions orchestration.
import type { BgMessage, BgRequests, BgType, OffscreenEvent, OffscreenMessage, TabMessage } from '../shared/messages';
import { loadSecrets, loadSettings } from '../shared/settings';
import { errorMessage } from '../shared/util';
import { deeplTranslate, translate } from './translate';
import { googleTranslate } from './google';
import { translateLines as claudeTranslate } from './claude';
import { lookup } from './dictionary';
import { explainWord } from './claude';
import { cacheClear, cacheGet, cacheSet } from './cache';

// ------------------------------------------------------------------ offscreen document

const OFFSCREEN_URL = 'offscreen.html';
let creatingOffscreen: Promise<void> | null = null;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [url] });
  if (contexts.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.DOM_PARSER],
        justification: 'Transcribe tab audio for AI captions and analyse Japanese/Chinese subtitle text.',
      })
      .finally(() => (creatingOffscreen = null));
  }
  await creatingOffscreen;
}

async function toOffscreen<T>(msg: OffscreenMessage): Promise<T> {
  await ensureOffscreen();
  let res: { ok: boolean; data?: T; error?: string } | undefined;
  // A freshly created document may not have registered its listener yet: retry briefly.
  for (let attempt = 0; ; attempt++) {
    try {
      res = (await chrome.runtime.sendMessage(msg)) as typeof res;
      break;
    } catch (e) {
      if (attempt >= 40 || !/Receiving end does not exist/i.test(errorMessage(e))) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!res) throw new Error('Offscreen document did not answer');
  if (!res.ok) throw new Error(res.error ?? 'Offscreen error');
  return res.data as T;
}

// ------------------------------------------------------------------ AI captions (tab capture)

const captures = new Map<number, { lang: string }>();

function tellTab(tabId: number, msg: TabMessage) {
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

async function startCapture(tabId: number, lang: string) {
  if (captures.has(tabId)) return { started: true };
  const [settings, secrets] = await Promise.all([loadSettings(), loadSecrets()]);
  const base = settings.sttBaseUrl.replace(/\/+$/, '');
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(base + '/');
  if (!secrets.sttKey && !local) throw new Error('Add a speech-to-text API key in Settings → AI to use AI captions.');
  const origin = new URL(base).origin + '/*';
  if (!(await chrome.permissions.contains({ origins: [origin] }))) {
    throw new Error(`Grant access to ${new URL(base).host} in Settings → AI (press "Test").`);
  }
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await toOffscreen({ target: 'offscreen', type: 'capture:start', tabId, streamId, lang, stt: { baseUrl: base, model: settings.sttModel, key: secrets.sttKey } });
  captures.set(tabId, { lang });
  tellTab(tabId, { type: 'cs:aiState', active: true });
  return { started: true };
}

async function stopCapture(tabId: number) {
  if (!captures.has(tabId)) return { stopped: false };
  captures.delete(tabId);
  await toOffscreen({ target: 'offscreen', type: 'capture:stop', tabId }).catch(() => {});
  tellTab(tabId, { type: 'cs:aiState', active: false });
  return { stopped: true };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (captures.has(tabId)) stopCapture(tabId);
});

chrome.commands?.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-ai-captions' || !tab?.id) return;
  try {
    if (captures.has(tab.id)) await stopCapture(tab.id);
    else await startCapture(tab.id, (await loadSettings()).targetLang);
  } catch (e) {
    tellTab(tab.id, { type: 'cs:aiState', active: false, error: errorMessage(e) });
  }
});

// ------------------------------------------------------------------ subtitle fetching

// Only hosts that serve subtitle files; keeps content scripts from using the worker as a generic proxy.
const FETCH_ALLOW = [
  /(^|\.)nflxvideo\.net$/,
  /(^|\.)nflxso\.net$/,
  /(^|\.)dssott\.com$/,
  /(^|\.)disney-plus\.net$/,
  /(^|\.)bamgrid\.com$/,
  /(^|\.)pv-cdn\.net$/,
  /(^|\.)cloudfront\.net$/,
  /(^|\.)media-amazon\.com$/,
  /(^|\.)aiv-cdn\.net$/,
  /(^|\.)youtube\.com$/,
];

async function fetchText(url: string) {
  const u = new URL(url);
  const allowed = u.protocol === 'https:' && FETCH_ALLOW.some((re) => re.test(u.hostname));
  const testHost = __TEST__ && /^(localhost|127\.0\.0\.1)$/.test(u.hostname);
  if (!allowed && !testHost) throw new Error(`Host not allowed: ${u.hostname}`);
  const res = await fetch(url, { credentials: 'omit' });
  return { status: res.status, text: res.ok ? await res.text() : '' };
}

// ------------------------------------------------------------------ router

type Handler<K extends BgType> = (req: BgRequests[K]['req'], sender: chrome.runtime.MessageSender) => Promise<BgRequests[K]['res']>;
const handlers: { [K in BgType]: Handler<K> } = {
  async translate(req) {
    const [settings, secrets] = await Promise.all([loadSettings(), loadSecrets()]);
    return translate(req.lines, req.from, req.to, settings, secrets, req.title);
  },
  async lookup(req) {
    const [settings, secrets] = await Promise.all([loadSettings(), loadSecrets()]);
    return lookup(req, settings, secrets);
  },
  async explain(req) {
    const [settings, secrets] = await Promise.all([loadSettings(), loadSecrets()]);
    if (__TEST__ && settings.translationProvider === 'mock' && !secrets.claudeKey) {
      return { lemma: req.word.toLowerCase(), reading: '', partOfSpeech: 'noun', meaning: `Meaning of ${req.word}`, grammar: 'Singular form.', otherMeanings: [], examples: [{ text: `Example ${req.word}`, translation: 'Ejemplo' }], sentenceTranslation: `[${req.to}] ${req.sentence}` };
    }
    if (!secrets.claudeKey) throw new Error('Add a Claude API key in Settings to use AI explanations.');
    const key = `ex|${settings.claudeModel}|${req.from}|${req.to}|${req.word}|${req.sentence}`;
    const cached = await cacheGet<Awaited<ReturnType<typeof explainWord>>>(key);
    if (cached) return cached;
    const res = await explainWord(secrets.claudeKey, settings.claudeModel, req.word, req.sentence, req.from, req.to);
    await cacheSet(key, res);
    return res;
  },
  async analyze(req) {
    return toOffscreen({ target: 'offscreen', type: 'analyze', lines: req.lines, lang: req.lang });
  },
  async fetchText(req) {
    return fetchText(req.url);
  },
  async 'capture:start'(req) {
    return startCapture(req.tabId, req.lang);
  },
  async 'capture:stop'(req) {
    return stopCapture(req.tabId);
  },
  async 'capture:status'(req) {
    return { active: captures.has(req.tabId) };
  },
  async 'ai:status'() {
    const [settings, secrets] = await Promise.all([loadSettings(), loadSecrets()]);
    const mock = __TEST__ && settings.translationProvider === 'mock';
    return { claude: !!secrets.claudeKey || mock, deepl: !!secrets.deeplKey, stt: !!secrets.sttKey || /localhost|127\.0\.0\.1/.test(settings.sttBaseUrl) };
  },
  async 'cache:clear'() {
    await cacheClear();
    return { cleared: true };
  },
  async testProvider(req) {
    const [settings, secrets] = await Promise.all([loadSettings(), loadSecrets()]);
    const lines = ['Hello, how are you today?'];
    let out: string[];
    if (req.provider === 'deepl') {
      if (!secrets.deeplKey) throw new Error('No DeepL API key');
      out = await deeplTranslate(secrets.deeplKey, lines, 'en', req.to);
    } else if (req.provider === 'claude') {
      if (!secrets.claudeKey) throw new Error('No Claude API key');
      out = await claudeTranslate(secrets.claudeKey, settings.claudeModel, lines, 'en', req.to);
    } else out = await googleTranslate(lines, 'en', req.to);
    return { sample: out[0] ?? '' };
  },
  async injectGeneric(req) {
    await chrome.scripting.executeScript({ target: { tabId: req.tabId }, files: ['content-main.js'], world: 'MAIN' });
    await chrome.scripting.executeScript({ target: { tabId: req.tabId }, files: ['content.js'] });
    return { injected: true };
  },
};

chrome.runtime.onMessage.addListener((msg: BgMessage | OffscreenEvent | OffscreenMessage, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  if ('target' in msg && msg.target === 'offscreen') return false;
  if (msg.type === 'offscreen:aiResult') {
    tellTab(msg.tabId, { type: 'cs:aiCues', wallStart: msg.wallStart, segments: msg.segments });
    return false;
  }
  if (msg.type === 'offscreen:aiState') {
    if (!msg.active) captures.delete(msg.tabId);
    tellTab(msg.tabId, { type: 'cs:aiState', active: msg.active, error: msg.error });
    return false;
  }
  const handler = handlers[msg.type as BgType] as Handler<BgType> | undefined;
  if (!handler) return false;
  handler(msg as never, sender).then(
    (data) => sendResponse({ ok: true, data }),
    (err) => sendResponse({ ok: false, error: errorMessage(err) }),
  );
  return true;
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install' && !__TEST__) chrome.runtime.openOptionsPage();
});
