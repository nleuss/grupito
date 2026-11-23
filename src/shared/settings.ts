// Settings persistence. Regular settings sync across devices (chrome.storage.sync);
// API keys stay on this device (chrome.storage.local).
import type { Secrets, Settings } from './types';
import { browserLang } from './languages';

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  sites: { netflix: true, youtube: true },
  targetLang: 'en',
  nativeLang: 'es',
  uiLang: 'auto',

  showPrimary: true,
  showTranslation: true,
  translationOnTop: false,
  blurTranslation: false,
  rubyReadings: true,
  romanizationLine: false,
  highlightSaved: true,
  fontScale: 1,
  translationScale: 0.82,
  bottomOffset: 9,
  bgOpacity: 0.62,
  primaryColor: '#ffffff',
  translationColor: '#ffd75e',
  fontFamily: 'system-ui, "Segoe UI", Roboto, "Noto Sans", "Noto Sans CJK JP", sans-serif',

  hideNativeSubs: true,
  autoPause: false,
  pauseOnHover: false,
  pauseOnWordClick: true,
  resumeAfterPopup: true,
  preferOfficialTranslation: true,

  translationProvider: 'auto',
  claudeModel: 'claude-opus-5-5',
  sttBaseUrl: 'https://api.openai.com/v1',
  sttModel: 'whisper-1',
  ankiDeck: 'Vidioma',
};

export const DEFAULT_SECRETS: Secrets = { claudeKey: '', deeplKey: '', sttKey: '' };

const SETTINGS_KEY = 'settings';
const SECRETS_KEY = 'secrets';

function mergeSettings(stored: Partial<Settings> | undefined): Settings {
  const s = { ...DEFAULT_SETTINGS, ...(stored ?? {}) } as Settings;
  s.sites = { ...DEFAULT_SETTINGS.sites, ...(stored?.sites ?? {}) };
  return s;
}

export async function loadSettings(): Promise<Settings> {
  const res = await chrome.storage.sync.get(SETTINGS_KEY);
  const stored = res[SETTINGS_KEY] as Partial<Settings> | undefined;
  if (!stored) {
    // First run: guess the native language from the browser.
    const native = browserLang();
    return mergeSettings({ nativeLang: native, targetLang: native === 'en' ? 'es' : 'en' });
  }
  return mergeSettings(stored);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next = mergeSettings({ ...current, ...patch });
  await chrome.storage.sync.set({ [SETTINGS_KEY]: next });
  return next;
}

export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'sync' && changes[SETTINGS_KEY]) cb(mergeSettings(changes[SETTINGS_KEY].newValue as Partial<Settings>));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export async function loadSecrets(): Promise<Secrets> {
  const res = await chrome.storage.local.get(SECRETS_KEY);
  return { ...DEFAULT_SECRETS, ...((res[SECRETS_KEY] as Partial<Secrets>) ?? {}) };
}

export async function saveSecrets(patch: Partial<Secrets>): Promise<Secrets> {
  const next = { ...(await loadSecrets()), ...patch };
  await chrome.storage.local.set({ [SECRETS_KEY]: next });
  return next;
}
