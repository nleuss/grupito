import { useEffect, useState } from 'preact/hooks';
import type { ContentStatus } from '../../shared/messages';
import { bg } from '../../shared/messages';
import type { StreamingSite } from '../../shared/types';
import { errorMessage } from '../../shared/util';
import { t } from '../../ui/i18n';
import { Brand, LanguageSelect, Switch, mount, openPage, useSettings } from '../shared';

const SITE_NAMES: Record<StreamingSite, string> = { netflix: 'Netflix', youtube: 'YouTube' };

function siteOf(url: string | undefined): StreamingSite | null {
  if (!url) return null;
  try {
    const h = new URL(url).hostname;
    if (/netflix\.com$/.test(h)) return 'netflix';
    if (/youtube\.com$/.test(h)) return 'youtube';
  } catch {
    /* ignore */
  }
  return null;
}

function Popup() {
  const [s, patch] = useSettings();
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);
  const [status, setStatus] = useState<ContentStatus | null>(null);
  const [ai, setAi] = useState<{ stt: boolean } | null>(null);
  const [aiActive, setAiActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = async (tb: chrome.tabs.Tab | null) => {
    if (!tb?.id) return;
    try {
      setStatus((await chrome.tabs.sendMessage(tb.id, { type: 'cs:status' })) as ContentStatus);
    } catch {
      setStatus(null);
    }
    bg('capture:status', { tabId: tb.id })
      .then((r) => setAiActive(r.active))
      .catch(() => {});
  };

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tb]) => {
      setTab(tb ?? null);
      refresh(tb ?? null);
    });
    bg('ai:status', {})
      .then(setAi)
      .catch(() => {});
    const id = setInterval(() => chrome.tabs.query({ active: true, currentWindow: true }).then(([tb]) => refresh(tb ?? null)), 1500);
    return () => clearInterval(id);
  }, []);

  if (!s) return <div class="pad muted">…</div>;
  const site = siteOf(tab?.url);
  const siteEnabled = site ? s.sites[site] !== false : true;
  const isWeb = !!tab?.url && /^https?:/.test(tab.url);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      refresh(tab);
    }
  };

  return (
    <div class="popup">
      <header class="row">
        <Brand />
        <span class="spacer" />
        <span class="muted small">{t('enabled')}</span>
        <Switch checked={s.enabled} onChange={(v) => patch({ enabled: v })} label={t('enabled')} />
      </header>

      <section class="langs">
        <label>
          <span class="muted small">{t('learning')}</span>
          <LanguageSelect compact value={s.targetLang} onChange={(v) => patch({ targetLang: v })} />
        </label>
        <span class="arrow">→</span>
        <label>
          <span class="muted small">{t('native')}</span>
          <LanguageSelect compact value={s.nativeLang} onChange={(v) => patch({ nativeLang: v })} />
        </label>
      </section>

      <section class="card status">
        {status?.active ? (
          <>
            <div class="row">
              <span class="pill ok">● {t('popupActive')}</span>
              <span class="title" title={status.videoTitle}>
                {status.videoTitle}
              </span>
            </div>
            <div class="small muted">
              {status.primaryLabel ? (
                <>
                  {status.primaryLabel}
                  {status.translationLabel
                    ? ` + ${status.translationLabel === 'machine' ? t('machineTranslation') : status.translationLabel === 'site' ? t('siteTranslation') : status.translationLabel}`
                    : ''}{' '}
                  · {t('lines', status.cueCount)}
                </>
              ) : status.message ? (
                status.message
              ) : (
                t('noTracksYet')
              )}
            </div>
          </>
        ) : site && !siteEnabled ? (
          <button class="btn primary" onClick={() => patch({ sites: { ...s.sites, [site]: true } })}>
            {t('enableOnSite', SITE_NAMES[site])}
          </button>
        ) : (
          <>
            <div class="small muted">{t('popupNoVideo')}</div>
            {isWeb && !site && !status && (
              <button class="btn" disabled={busy} onClick={() => run(() => bg('injectGeneric', { tabId: tab!.id! }))}>
                {t('popupUseHere')}
              </button>
            )}
          </>
        )}
      </section>

      {isWeb && (
        <section class="ai">
          <button
            class={`btn ${aiActive ? '' : 'primary'} wide`}
            disabled={busy || (!ai?.stt && !aiActive)}
            onClick={() =>
              run(async () => {
                if (aiActive) await bg('capture:stop', { tabId: tab!.id! });
                else {
                  if (!status) await bg('injectGeneric', { tabId: tab!.id! }).catch(() => {});
                  await bg('capture:start', { tabId: tab!.id!, lang: s.targetLang });
                }
              })
            }
          >
            {aiActive ? `■ ${t('aiStop')}` : `✨ ${t('aiStart')}`}
          </button>
          <div class="small muted">{ai && !ai.stt ? t('aiNeedsKey') : t('aiHint')}</div>
        </section>
      )}
      {error && <div class="error small">{error}</div>}

      <section class="toggles">
        <label class="row">
          <Switch checked={s.showTranslation} onChange={(v) => patch({ showTranslation: v })} />
          <span>{t('showTranslation')}</span>
        </label>
        <label class="row">
          <Switch checked={s.autoPause} onChange={(v) => patch({ autoPause: v })} />
          <span>{t('autoPause')}</span>
        </label>
        <label class="row">
          <Switch checked={s.blurTranslation} onChange={(v) => patch({ blurTranslation: v })} />
          <span>{t('blurTranslation')}</span>
        </label>
      </section>

      <footer class="links">
        <button class="btn" onClick={() => openPage('pages/vocab.html')}>
          ★ {t('openVocab')}
        </button>
        <button class="btn" onClick={() => openPage('pages/player.html')}>
          ▶ {t('openPlayer')}
        </button>
        <button class="btn" onClick={() => chrome.runtime.openOptionsPage()}>
          ⚙ {t('openSettings')}
        </button>
      </footer>
    </div>
  );
}

mount(<Popup />);
