// Small UI helpers shared by the extension pages.
import { render, type ComponentChildren, type VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Settings } from '../shared/types';
import { loadSettings, onSettingsChanged, saveSettings } from '../shared/settings';
import { setUiLang } from '../ui/i18n';
import { LANGUAGES } from '../shared/languages';
import { uiLang } from '../ui/i18n';

/** Load settings (and keep them in sync); applies the UI language before rendering. */
export function useSettings(): [Settings | null, (p: Partial<Settings>) => Promise<void>] {
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    loadSettings().then((x) => {
      setUiLang(x.uiLang);
      setS(x);
    });
    return onSettingsChanged((x) => {
      setUiLang(x.uiLang);
      setS(x);
    });
  }, []);
  const patch = async (p: Partial<Settings>) => {
    const next = await saveSettings(p);
    setUiLang(next.uiLang);
    setS(next);
  };
  return [s, patch];
}

export function mount(node: VNode) {
  loadSettings()
    .then((s) => setUiLang(s.uiLang))
    .finally(() => render(node, document.getElementById('app')!));
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label class="switch" title={label}>
      <input type="checkbox" checked={checked} aria-label={label} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
      <span />
    </label>
  );
}

export function LanguageSelect({ value, onChange, id, compact }: { value: string; onChange: (v: string) => void; id?: string; compact?: boolean }) {
  const ui = uiLang();
  const name = (l: (typeof LANGUAGES)[number]) => (ui === 'es' ? l.es : l.en);
  const sorted = [...LANGUAGES].sort((a, b) => name(a).localeCompare(name(b)));
  return (
    <select class="input" id={id} value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
      {sorted.map((l) => (
        <option value={l.code}>{compact || name(l) === l.native ? name(l) : `${name(l)} — ${l.native}`}</option>
      ))}
    </select>
  );
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string, error = false) {
  document.querySelectorAll('.toast').forEach((e) => e.remove());
  const el = document.createElement('div');
  el.className = `toast${error ? ' err' : ''}`;
  el.textContent = text;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), error ? 6000 : 2400);
}

export function Brand({ children }: { children?: ComponentChildren }) {
  return (
    <span class="brand">
      <span class="brand-dot" />
      Vidioma{children}
    </span>
  );
}

export function openPage(path: string) {
  chrome.tabs.create({ url: chrome.runtime.getURL(path) });
}
