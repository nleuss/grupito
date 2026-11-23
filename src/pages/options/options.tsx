import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { Secrets, Settings, StreamingSite, TranslationProvider } from '../../shared/types';
import { loadSecrets, saveSecrets } from '../../shared/settings';
import { bg } from '../../shared/messages';
import { listVocab, importVocab } from '../../shared/vocab';
import { downloadBlob, errorMessage } from '../../shared/util';
import { t } from '../../ui/i18n';
import { transcribe } from '../../ai/stt';
import { encodeWav } from '../../ai/audio';
import { Brand, LanguageSelect, Switch, mount, toast, useSettings } from '../shared';
import { CLAUDE_MODELS } from '../../background/claude-models';

const SITES: { id: StreamingSite; name: string }[] = [
  { id: 'youtube', name: 'YouTube' },
  { id: 'netflix', name: 'Netflix' },
];

function Section({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <section class="card section">
      <h2>{title}</h2>
      <div class="fields">{children}</div>
    </section>
  );
}

function Field({ label, hint, children, inline }: { label: string; hint?: string; children: ComponentChildren; inline?: boolean }) {
  return (
    <div class={`field${inline ? ' inline' : ''}`}>
      <div class="label">
        <span>{label}</span>
        {hint && <span class="hint">{hint}</span>}
      </div>
      <div class="control">{children}</div>
    </div>
  );
}

function Toggle({ s, k, label, hint, patch }: { s: Settings; k: keyof Settings; label: string; hint?: string; patch: (p: Partial<Settings>) => void }) {
  return (
    <Field label={label} hint={hint} inline>
      <Switch checked={!!s[k]} onChange={(v) => patch({ [k]: v } as Partial<Settings>)} label={label} />
    </Field>
  );
}

function Range({ value, min, max, step, onChange, format }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string }) {
  return (
    <div class="row range">
      <input type="range" min={min} max={max} step={step} value={value} onInput={(e) => onChange(parseFloat((e.target as HTMLInputElement).value))} />
      <span class="muted small value">{format ? format(value) : value}</span>
    </div>
  );
}

function SecretInput({ value, onSave, placeholder }: { value: string; onSave: (v: string) => void; placeholder?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      class="input"
      type="password"
      autoComplete="off"
      spellcheck={false}
      placeholder={placeholder}
      value={v}
      onInput={(e) => setV((e.target as HTMLInputElement).value)}
      onBlur={() => v !== value && onSave(v.trim())}
    />
  );
}

function Options() {
  const [s, patch] = useSettings();
  const [secrets, setSecrets] = useState<Secrets | null>(null);
  const [testing, setTesting] = useState<string>('');

  useEffect(() => {
    loadSecrets().then(setSecrets);
  }, []);

  if (!s || !secrets) return <div class="page muted">…</div>;

  const saveSecret = async (p: Partial<Secrets>) => {
    setSecrets(await saveSecrets(p));
    toast(t('savedSettings'));
  };

  const test = async (what: 'google' | 'deepl' | 'claude' | 'stt') => {
    setTesting(what);
    try {
      if (what === 'stt') {
        const base = s.sttBaseUrl.replace(/\/+$/, '');
        const origin = `${new URL(base).origin}/*`;
        if (!(await chrome.permissions.contains({ origins: [origin] }))) {
          const granted = await chrome.permissions.request({ origins: [origin] });
          if (!granted) throw new Error('Permission denied');
        }
        await transcribe(encodeWav(new Float32Array(16000)), 1, { baseUrl: base, model: s.sttModel, key: secrets.sttKey });
        toast(t('testOk'));
      } else {
        const r = await bg('testProvider', { provider: what, to: s.nativeLang });
        toast(`${t('testOk')} “${r.sample}”`);
      }
    } catch (e) {
      toast(errorMessage(e), true);
    } finally {
      setTesting('');
    }
  };

  const exportAll = async () => {
    const data = { app: 'vidioma', version: 1, exportedAt: new Date().toISOString(), settings: s, vocabulary: await listVocab() };
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `vidioma-backup-${new Date().toISOString().slice(0, 10)}.json`);
  };

  const importAll = async (file: File | undefined) => {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.settings) await patch(data.settings);
      const n = Array.isArray(data.vocabulary) ? await importVocab(data.vocabulary) : 0;
      toast(t('imported', n));
    } catch (e) {
      toast(errorMessage(e), true);
    }
  };

  const providers: { id: TranslationProvider; label: string }[] = [
    { id: 'auto', label: t('providerAuto') },
    { id: 'chrome', label: t('providerChrome') },
    { id: 'google', label: t('providerGoogle') },
    { id: 'deepl', label: t('providerDeepl') },
    { id: 'claude', label: t('providerClaude') },
  ];
  if (__TEST__) providers.push({ id: 'mock', label: 'Mock (test build)' });

  return (
    <div class="page">
      <header class="top">
        <Brand>
          <span class="muted"> · {t('settingsTitle')}</span>
        </Brand>
      </header>

      <Section title={t('secLanguages')}>
        <Field label={t('learning')}>
          <LanguageSelect value={s.targetLang} onChange={(v) => patch({ targetLang: v })} />
        </Field>
        <Field label={t('native')}>
          <LanguageSelect value={s.nativeLang} onChange={(v) => patch({ nativeLang: v })} />
        </Field>
        <Field label={t('uiLanguage')}>
          <select class="input" value={s.uiLang} onChange={(e) => patch({ uiLang: (e.target as HTMLSelectElement).value as Settings['uiLang'] })}>
            <option value="auto">{t('uiAuto')}</option>
            <option value="en">English</option>
            <option value="es">Español</option>
          </select>
        </Field>
      </Section>

      <Section title={t('secAppearance')}>
        <div class="preview" style={{ '--p': s.primaryColor, '--t': s.translationColor, '--bg': `rgba(8,8,12,${s.bgOpacity})`, '--fs': `${22 * s.fontScale}px`, '--ts': String(s.translationScale) } as Record<string, string>}>
          <div class="pline">
            The <u>quick</u> brown fox jumps
          </div>
          <div class="tline">El rápido zorro marrón salta</div>
        </div>
        <Field label={t('fontSize')}>
          <Range value={s.fontScale} min={0.5} max={2.5} step={0.05} onChange={(v) => patch({ fontScale: v })} format={(v) => `${Math.round(v * 100)}%`} />
        </Field>
        <Field label={t('translationSize')}>
          <Range value={s.translationScale} min={0.5} max={1.2} step={0.02} onChange={(v) => patch({ translationScale: v })} format={(v) => `${Math.round(v * 100)}%`} />
        </Field>
        <Field label={t('bottomOffset')}>
          <Range value={s.bottomOffset} min={2} max={40} step={1} onChange={(v) => patch({ bottomOffset: v })} format={(v) => `${v}%`} />
        </Field>
        <Field label={t('bgOpacity')}>
          <Range value={s.bgOpacity} min={0} max={1} step={0.02} onChange={(v) => patch({ bgOpacity: v })} format={(v) => `${Math.round(v * 100)}%`} />
        </Field>
        <Field label={t('primaryColor')} inline>
          <input type="color" value={s.primaryColor} onInput={(e) => patch({ primaryColor: (e.target as HTMLInputElement).value })} />
        </Field>
        <Field label={t('translationColor')} inline>
          <input type="color" value={s.translationColor} onInput={(e) => patch({ translationColor: (e.target as HTMLInputElement).value })} />
        </Field>
        <Toggle s={s} k="showTranslation" label={t('showTranslation')} patch={patch} />
        <Toggle s={s} k="translationOnTop" label={t('translationOnTop')} patch={patch} />
        <Toggle s={s} k="blurTranslation" label={t('blurTranslation')} patch={patch} />
        <Toggle s={s} k="rubyReadings" label={t('readings')} patch={patch} />
        <Toggle s={s} k="romanizationLine" label={t('romanization')} patch={patch} />
        <Toggle s={s} k="highlightSaved" label={t('highlightSaved')} patch={patch} />
      </Section>

      <Section title={t('secBehavior')}>
        <Toggle s={s} k="autoPause" label={t('autoPause')} patch={patch} />
        <Toggle s={s} k="pauseOnWordClick" label={t('pauseOnWordClick')} patch={patch} />
        <Toggle s={s} k="resumeAfterPopup" label={t('resumeAfterPopup')} patch={patch} />
        <Toggle s={s} k="pauseOnHover" label={t('pauseOnHover')} patch={patch} />
        <Toggle s={s} k="hideNativeSubs" label={t('hideNativeSubs')} patch={patch} />
        <Toggle s={s} k="preferOfficialTranslation" label={t('preferOfficial')} patch={patch} />
      </Section>

      <Section title={t('secTranslation')}>
        <Field label={t('provider')}>
          <select class="input" value={s.translationProvider} onChange={(e) => patch({ translationProvider: (e.target as HTMLSelectElement).value as TranslationProvider })}>
            {providers.map((p) => (
              <option value={p.id}>{p.label}</option>
            ))}
          </select>
        </Field>
        {(s.translationProvider === 'google' || s.translationProvider === 'auto') && (
          <div class="row">
            <button class="btn small" disabled={!!testing} onClick={() => test('google')}>
              {testing === 'google' ? t('testing') : `${t('test')} Google`}
            </button>
          </div>
        )}
        <Field label={t('deeplKey')} hint="https://www.deepl.com/pro-api">
          <div class="row">
            <SecretInput value={secrets.deeplKey} onSave={(v) => saveSecret({ deeplKey: v })} placeholder="xxxxxxxx-xxxx-…:fx" />
            <button class="btn small" disabled={!secrets.deeplKey || !!testing} onClick={() => test('deepl')}>
              {testing === 'deepl' ? t('testing') : t('test')}
            </button>
          </div>
        </Field>
      </Section>

      <Section title={t('secAi')}>
        <Field label={t('claudeKey')} hint={t('claudeHint')}>
          <div class="row">
            <SecretInput value={secrets.claudeKey} onSave={(v) => saveSecret({ claudeKey: v })} placeholder="sk-ant-…" />
            <button class="btn small" disabled={!secrets.claudeKey || !!testing} onClick={() => test('claude')}>
              {testing === 'claude' ? t('testing') : t('test')}
            </button>
          </div>
        </Field>
        <Field label={t('claudeModel')}>
          <select class="input" value={s.claudeModel} onChange={(e) => patch({ claudeModel: (e.target as HTMLSelectElement).value })}>
            {CLAUDE_MODELS.map((m) => (
              <option value={m.id}>{m.label}</option>
            ))}
          </select>
        </Field>
        <h3 class="sub">{t('sttTitle')}</h3>
        <p class="hint">{t('sttHint')}</p>
        <Field label={t('sttBaseUrl')}>
          <input class="input" value={s.sttBaseUrl} spellcheck={false} onBlur={(e) => patch({ sttBaseUrl: (e.target as HTMLInputElement).value.trim() })} />
          <div class="row presets">
            <button class="btn small ghost" onClick={() => patch({ sttBaseUrl: 'https://api.openai.com/v1', sttModel: 'whisper-1' })}>
              OpenAI
            </button>
            <button class="btn small ghost" onClick={() => patch({ sttBaseUrl: 'https://api.groq.com/openai/v1', sttModel: 'whisper-large-v3-turbo' })}>
              Groq
            </button>
            <button class="btn small ghost" onClick={() => patch({ sttBaseUrl: 'http://localhost:8000/v1', sttModel: 'whisper-1' })}>
              Local
            </button>
          </div>
        </Field>
        <Field label={t('sttModel')}>
          <input class="input" value={s.sttModel} spellcheck={false} onBlur={(e) => patch({ sttModel: (e.target as HTMLInputElement).value.trim() })} />
        </Field>
        <Field label={t('sttKey')}>
          <div class="row">
            <SecretInput value={secrets.sttKey} onSave={(v) => saveSecret({ sttKey: v })} placeholder="sk-… / gsk_…" />
            <button class="btn small" disabled={!!testing} onClick={() => test('stt')}>
              {testing === 'stt' ? t('testing') : t('test')}
            </button>
          </div>
        </Field>
      </Section>

      <Section title={t('secSites')}>
        {SITES.map((site) => (
          <Field label={site.name} inline>
            <Switch checked={s.sites[site.id] !== false} onChange={(v) => patch({ sites: { ...s.sites, [site.id]: v } })} label={site.name} />
          </Field>
        ))}
      </Section>

      <Section title={t('secShortcuts')}>
        <table class="keys">
          <tbody>
            {[
              ['A', t('prevLine')],
              ['S', t('repeatLine')],
              ['D', t('nextLine')],
              ['Q', t('autoPause')],
              ['W', t('showTranslation')],
              ['E', t('revealTranslation')],
              ['R', t('romanization')],
              ['G', t('transcript')],
              ['[ / ]', t('sync')],
              ['Esc', t('close')],
              ['Alt+Shift+C', t('aiStart')],
            ].map(([k, label]) => (
              <tr>
                <td>
                  <kbd>{k}</kbd>
                </td>
                <td>{label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title={t('secData')}>
        <Field label={t('ankiDeck')}>
          <input class="input" value={s.ankiDeck} onBlur={(e) => patch({ ankiDeck: (e.target as HTMLInputElement).value.trim() || 'Vidioma' })} />
        </Field>
        <div class="row wrap">
          <button class="btn" onClick={exportAll}>
            ⬇ {t('exportData')}
          </button>
          <label class="btn">
            ⬆ {t('importData')}
            <input type="file" accept="application/json,.json" hidden onChange={(e) => importAll((e.target as HTMLInputElement).files?.[0])} />
          </label>
          <button
            class="btn"
            onClick={async () => {
              await bg('cache:clear', {});
              toast(t('cacheCleared'));
            }}
          >
            🗑 {t('clearCache')}
          </button>
        </div>
      </Section>
    </div>
  );
}

mount(<Options />);
