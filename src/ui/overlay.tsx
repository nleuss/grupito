// Overlay UI rendered on top of the video (inside a shadow root on streaming sites).
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { Settings, Token } from '../shared/types';
import { useStore } from '../shared/store';
import { formatTime } from '../shared/util';
import { baseLang, googleCode, hasRomanization } from '../shared/languages';
import type { SubtitleController } from './controller';
import { readTextFile, pickFile, SUBTITLE_ACCEPT } from './files';
import { t } from './i18n';

export interface OverlayProps {
  ctl: SubtitleController;
  patchSettings: (p: Partial<Settings>) => void;
  /** Show the in-video toolbar (the player page has its own controls). */
  toolbar?: boolean;
  /** Show the floating transcript panel inside the overlay. */
  floatingTranscript?: boolean;
}

export function Overlay({ ctl, patchSettings, toolbar = true, floatingTranscript = true }: OverlayProps) {
  const s = useStore(ctl.store, (st) => st.settings);
  const hidden = useStore(ctl.store, (st) => st.hidden);
  const transcriptOpen = useStore(ctl.store, (st) => st.transcriptOpen);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close the word popup when clicking anywhere outside it. Inside a (closed) shadow root the
  // event path stops at the host element, so any click on our own overlay counts as inside.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ctl.state.popup) return;
      const path = e.composedPath();
      const root = rootRef.current?.getRootNode();
      const shadowHost = root instanceof ShadowRoot ? root.host : null;
      if (shadowHost && path.includes(shadowHost)) return;
      if (path.some((n) => n instanceof HTMLElement && (n.classList.contains('vd-pop') || n.classList.contains('vd-w')))) return;
      ctl.closePopup();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [ctl]);

  const vars = {
    '--vd-scale': String(s.fontScale),
    '--vd-tscale': String(s.translationScale),
    '--vd-bottom': `${s.bottomOffset}%`,
    '--vd-bg': `rgba(8, 8, 12, ${s.bgOpacity})`,
    '--vd-color': s.primaryColor,
    '--vd-tcolor': s.translationColor,
    '--vd-font': s.fontFamily,
  } as Record<string, string>;

  return (
    <div class="vd-root" ref={rootRef} style={vars}>
      {!hidden && <SubtitleBox ctl={ctl} />}
      <WordPopup ctl={ctl} />
      {floatingTranscript && transcriptOpen && <Transcript ctl={ctl} />}
      {toolbar && <Toolbar ctl={ctl} patchSettings={patchSettings} />}
      <Toast ctl={ctl} />
    </div>
  );
}

// ---------------------------------------------------------------- subtitles

function SubtitleBox({ ctl }: { ctl: SubtitleController }) {
  const st = useStore(ctl.store, (x) => ({ active: x.active, status: x.status, version: x.version, settings: x.settings, cues: x.cues, saved: x.saved, popup: x.popup, reveal: x.revealTranslation, translationId: x.translationId }));
  if (!st.active.length) {
    if (st.status === 'loading') return <div class="vd-subs"><div class="vd-pill">{t('loadingSubs')}</div></div>;
    return null;
  }
  return (
    <div class="vd-subs" onMouseEnter={() => ctl.hoverStart()} onMouseLeave={() => ctl.hoverEnd()}>
      {st.active.map((i) => (
        <CueBlock key={i} ctl={ctl} index={i} />
      ))}
    </div>
  );
}

function CueBlock({ ctl, index }: { ctl: SubtitleController; index: number }) {
  const st = ctl.state;
  const s = st.settings;
  const lang = ctl.primaryTrack()?.lang ?? s.targetLang;
  const analysis = ctl.analysisFor(index);
  const translation = ctl.translationFor(index);
  const popup = st.popup;

  const onWord = (e: MouseEvent, ti: number) => {
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const root = el.closest('.vd-root')!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    ctl.openWord(index, ti, r.left + r.width / 2 - root.left, r.top - root.top);
  };

  const primary = s.showPrimary ? (
    <div class="vd-line vd-primary" dir="auto" lang={lang} key="p">
      {analysis.tokens.map((tk, ti) =>
        tk.text === '\n' || /^\n+$/.test(tk.text) ? (
          <br key={ti} />
        ) : tk.word ? (
          <span
            key={ti}
            class={`vd-w${ctl.isSaved(tk.text, tk.lemma) && s.highlightSaved ? ' vd-saved' : ''}${popup?.cueIndex === index && popup.tokenIndex === ti ? ' vd-sel' : ''}`}
            onClick={(e) => onWord(e as unknown as MouseEvent, ti)}
          >
            <TokenText token={tk} ruby={s.rubyReadings} />
          </span>
        ) : (
          <span key={ti}>{tk.text}</span>
        ),
      )}
    </div>
  ) : null;

  const roman =
    s.romanizationLine && analysis.roman ? (
      <div class="vd-line vd-roman" key="r">
        {analysis.roman}
      </div>
    ) : null;

  const trans =
    s.showTranslation && st.translationId ? (
      <div
        key="t"
        class={`vd-line vd-trans${s.blurTranslation && !st.revealTranslation ? ' vd-blur' : ''}`}
        dir="auto"
        lang={s.nativeLang}
      >
        {translation ?? <span class="vd-dim">…</span>}
      </div>
    ) : null;

  return <div class="vd-cue">{s.translationOnTop ? [trans, roman, primary] : [primary, roman, trans]}</div>;
}

function TokenText({ token, ruby }: { token: Token; ruby: boolean }) {
  if (!ruby || !token.ruby?.some((p) => p.rt)) return <>{token.text}</>;
  return (
    <>
      {token.ruby.map((p, i) =>
        p.rt ? (
          <ruby key={i}>
            {p.base}
            <rt>{p.rt}</rt>
          </ruby>
        ) : (
          <span key={i}>{p.base}</span>
        ),
      )}
    </>
  );
}

// ---------------------------------------------------------------- word popup

function WordPopup({ ctl }: { ctl: SubtitleController }) {
  const popup = useStore(ctl.store, (x) => x.popup);
  const ai = useStore(ctl.store, (x) => x.ai);
  const settings = useStore(ctl.store, (x) => x.settings);
  if (!popup) return null;
  const lang = ctl.primaryTrack()?.lang ?? settings.targetLang;
  const lk = popup.lookup;
  const ex = popup.explain;
  const reading = popup.reading && popup.reading !== popup.word ? popup.reading : lk?.romanization;
  const gt = `https://translate.google.com/?sl=${googleCode(lang)}&tl=${googleCode(settings.nativeLang)}&text=${encodeURIComponent(popup.sentence)}&op=translate`;
  const wk = `https://en.wiktionary.org/wiki/${encodeURIComponent(popup.lemma ?? popup.word)}`;

  return (
    <div
      class="vd-pop"
      style={{ left: `clamp(8px, ${popup.x}px - 170px, calc(100% - 348px))`, top: `${popup.y}px` }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div class="vd-pop-head">
        <div class="vd-pop-title">
          <span class="vd-pop-word" lang={lang}>
            {popup.word}
          </span>
          {reading && <span class="vd-pop-reading">{reading}</span>}
        </div>
        <button class="vd-ib" title={t('listen')} onClick={() => ctl.speakText(popup.lemma ?? popup.word)}>
          🔊
        </button>
        <button class={`vd-ib${popup.saved ? ' vd-on' : ''}`} title={popup.saved ? t('saved') : t('save')} onClick={() => ctl.saveWord()}>
          {popup.saved ? '★' : '☆'}
        </button>
        <button class="vd-ib" title={t('close')} onClick={() => ctl.closePopup()}>
          ✕
        </button>
      </div>
      <div class="vd-pop-body">
        {popup.lemma && (
          <div class="vd-pop-lemma">
            {t('lemma')}: <b lang={lang}>{popup.lemma}</b>
          </div>
        )}
        {popup.loading ? (
          <div class="vd-pop-loading">
            <span class="vd-spin" /> {t('lookingUp')}
          </div>
        ) : popup.error ? (
          <div class="vd-err">{t('lookupFailed')}: {popup.error}</div>
        ) : lk ? (
          <>
            {lk.translation && <div class="vd-pop-tr">{lk.translation}</div>}
            {lk.entries.slice(0, 4).map((e) => (
              <div class="vd-pop-entry">
                <span class="vd-pos">{e.pos}</span> {e.terms.slice(0, 6).join(', ')}
              </div>
            ))}
            {lk.definitions.length > 0 && (
              <details class="vd-defs" open={!lk.entries.length}>
                <summary>{t('definitions')}</summary>
                <ol>
                  {lk.definitions.slice(0, 5).map((d) => (
                    <li>
                      {d.pos && <span class="vd-pos">{d.pos}</span>} {d.text}
                      {d.example && <div class="vd-ex">“{d.example}”</div>}
                    </li>
                  ))}
                </ol>
              </details>
            )}
            {!lk.translation && !lk.entries.length && !lk.definitions.length && <div class="vd-dim">{t('noResults')}</div>}
          </>
        ) : null}

        <div class="vd-pop-ai">
          {ex ? (
            <div class="vd-explain">
              <div class="vd-x-row">
                <b>{t('meaningInContext')}</b> {ex.meaning}
              </div>
              {(ex.lemma || ex.partOfSpeech) && (
                <div class="vd-x-row vd-dim">
                  {ex.lemma}
                  {ex.reading ? ` · ${ex.reading}` : ''}
                  {ex.partOfSpeech ? ` · ${ex.partOfSpeech}` : ''}
                </div>
              )}
              {ex.grammar && (
                <div class="vd-x-row">
                  <b>{t('grammar')}</b> {ex.grammar}
                </div>
              )}
              {ex.otherMeanings.length > 0 && (
                <div class="vd-x-row">
                  <b>{t('otherMeanings')}</b> {ex.otherMeanings.join(' · ')}
                </div>
              )}
              {ex.examples.length > 0 && (
                <div class="vd-x-row">
                  <b>{t('examples')}</b>
                  <ul>
                    {ex.examples.slice(0, 3).map((e) => (
                      <li>
                        <span lang={lang}>{e.text}</span> <span class="vd-dim">— {e.translation}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <button class="vd-btn vd-ai" disabled={!ai.claude || popup.explaining} onClick={() => ctl.explainWord()}>
              {popup.explaining ? (
                <>
                  <span class="vd-spin" /> {t('explaining')}
                </>
              ) : (
                `✨ ${t('explainAi')}`
              )}
            </button>
          )}
          {!ai.claude && !ex && <div class="vd-hint">{t('noAiKey')}</div>}
          {popup.explainError && <div class="vd-err">{popup.explainError}</div>}
        </div>
      </div>
      <div class="vd-pop-foot">
        <a href={gt} target="_blank" rel="noreferrer">
          Google Translate
        </a>
        <a href={wk} target="_blank" rel="noreferrer">
          Wiktionary
        </a>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- transcript

export function Transcript({ ctl, docked = false }: { ctl: SubtitleController; docked?: boolean }) {
  const st = useStore(ctl.store, (x) => ({ cues: x.cues, current: x.current, version: x.version, translationId: x.translationId, settings: x.settings }));
  const listRef = useRef<HTMLDivElement>(null);
  const userScrolledAt = useRef(0);
  const lang = ctl.primaryTrack()?.lang ?? st.settings.targetLang;

  useEffect(() => {
    if (Date.now() - userScrolledAt.current < 4000 || st.current < 0) return;
    const el = listRef.current?.querySelector(`[data-i="${st.current}"]`) as HTMLElement | null;
    const list = listRef.current;
    if (el && list) list.scrollTo({ top: el.offsetTop - list.clientHeight / 2 + el.clientHeight / 2, behavior: 'smooth' });
  }, [st.current]);

  return (
    <div class={`vd-transcript${docked ? ' vd-docked' : ''}`} onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div class="vd-tr-head">
        <span>
          {t('transcript')} <span class="vd-dim">({st.cues.length})</span>
        </span>
        {!docked && (
          <button class="vd-ib" onClick={() => ctl.toggleTranscript(false)} title={t('close')}>
            ✕
          </button>
        )}
      </div>
      <div class="vd-tr-list" ref={listRef} onWheel={() => (userScrolledAt.current = Date.now())} onTouchMove={() => (userScrolledAt.current = Date.now())}>
        {st.cues.length === 0 && <div class="vd-dim vd-pad">{t('noLinesYet')}</div>}
        {st.cues.map((c, i) => (
          <div key={i} data-i={i} class={`vd-tr-row${i === st.current ? ' vd-cur' : ''}`} onClick={() => ctl.seekToCue(i)}>
            <span class="vd-tr-time">{formatTime(c.start)}</span>
            <div class="vd-tr-text">
              <div lang={lang} dir="auto">
                {c.text}
              </div>
              {st.translationId && (
                <div class="vd-tr-trans" dir="auto">
                  {ctl.translationFor(i) ?? ''}
                </div>
              )}
            </div>
            <button
              class="vd-ib vd-tr-save"
              title={t('saveSentence')}
              onClick={(e) => {
                e.stopPropagation();
                ctl.saveSentence(i);
              }}
            >
              ☆
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- toolbar

function Toolbar({ ctl, patchSettings }: { ctl: SubtitleController; patchSettings: (p: Partial<Settings>) => void }) {
  const st = useStore(ctl.store, (x) => ({ tracks: x.tracks, primaryId: x.primaryId, translationId: x.translationId, settings: x.settings, visible: x.controlsVisible, status: x.status, message: x.message, transcriptOpen: x.transcriptOpen, hidden: x.hidden, syncOffset: x.syncOffset, aiActive: x.aiActive, rate: x.rate }));
  const [menu, setMenu] = useState(false);
  const s = st.settings;
  const primary = ctl.primaryTrack();
  const show = st.visible || menu || st.status === 'empty' || st.status === 'error';
  const rate = st.rate;

  const loadFile = async (as: 'primary' | 'translation') => {
    const f = await pickFile(SUBTITLE_ACCEPT);
    if (!f) return;
    try {
      ctl.addFileTrack(f.name, await readTextFile(f), as);
    } catch (e) {
      ctl.showToast(String((e as Error).message ?? e), true);
    }
  };

  return (
    <div class={`vd-toolbar${show ? ' vd-show' : ''}`} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <div class="vd-bar">
        <button class={`vd-brand${st.hidden ? ' vd-off' : ''}`} title={st.hidden ? t('showSubs') : t('hideSubs')} onClick={() => ctl.toggleHidden()}>
          <span class="vd-dot" />
          Vidioma
        </button>
        <label class="vd-sel" title={t('subtitleTrack')}>
          <span>{t('subsShort')}</span>
          <select value={st.primaryId ?? ''} onChange={(e) => ctl.selectPrimary((e.target as HTMLSelectElement).value)}>
            {!st.primaryId && <option value="">—</option>}
            {st.tracks.map((tr) => (
              <option value={tr.id}>{tr.label}</option>
            ))}
          </select>
        </label>
        <label class="vd-sel" title={t('translationTrack')}>
          <span>{t('transShort')}</span>
          <select
            value={st.translationId ?? 'off'}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              ctl.selectTranslation(v === 'off' ? null : v);
            }}
          >
            <option value="off">{t('off')}</option>
            <option value="machine">{t('machineTranslation')}</option>
            {primary?.siteTranslatable && <option value="site">{t('siteTranslation')}</option>}
            {st.tracks
              .filter((tr) => tr.id !== st.primaryId)
              .map((tr) => (
                <option value={tr.id}>{tr.label}</option>
              ))}
          </select>
        </label>
        <button class={`vd-ib${s.autoPause ? ' vd-on' : ''}`} title={`${t('autoPause')} (Q)`} onClick={() => patchSettings({ autoPause: !s.autoPause })}>
          ⏸
        </button>
        <button class="vd-ib" title={`${t('prevLine')} (A)`} onClick={() => ctl.prev()}>
          ⏮
        </button>
        <button class="vd-ib" title={`${t('repeatLine')} (S)`} onClick={() => ctl.repeat()}>
          ⟲
        </button>
        <button class="vd-ib" title={`${t('nextLine')} (D)`} onClick={() => ctl.next()}>
          ⏭
        </button>
        <button class={`vd-ib${st.transcriptOpen ? ' vd-on' : ''}`} title={`${t('transcript')} (G)`} onClick={() => ctl.toggleTranscript()}>
          ☰
        </button>
        <button class={`vd-ib${menu ? ' vd-on' : ''}`} title={t('more')} onClick={() => setMenu(!menu)}>
          ⚙
        </button>
      </div>
      {(st.status === 'empty' || st.status === 'error') && st.message && <div class="vd-msg">{st.message}</div>}
      {st.aiActive && <div class="vd-msg vd-ai-badge">● {t('aiListening')}</div>}
      {menu && (
        <div class="vd-menu">
          <Check label={`${t('showTranslation')} (W)`} value={s.showTranslation} onChange={(v) => patchSettings({ showTranslation: v })} />
          <Check label={t('blurTranslation')} value={s.blurTranslation} onChange={(v) => patchSettings({ blurTranslation: v })} />
          <Check label={t('translationOnTop')} value={s.translationOnTop} onChange={(v) => patchSettings({ translationOnTop: v })} />
          {hasRomanization(primary?.lang ?? s.targetLang) && (
            <>
              {['ja', 'zh'].includes(baseLang(primary?.lang ?? s.targetLang)) && (
                <Check label={t('readings')} value={s.rubyReadings} onChange={(v) => patchSettings({ rubyReadings: v })} />
              )}
              <Check label={`${t('romanization')} (R)`} value={s.romanizationLine} onChange={(v) => patchSettings({ romanizationLine: v })} />
            </>
          )}
          <Check label={t('pauseOnHover')} value={s.pauseOnHover} onChange={(v) => patchSettings({ pauseOnHover: v })} />
          <Check label={t('hideNativeSubs')} value={s.hideNativeSubs} onChange={(v) => patchSettings({ hideNativeSubs: v })} />
          <Row label={t('fontSize')}>
            <button class="vd-btn" onClick={() => patchSettings({ fontScale: Math.max(0.5, +(s.fontScale - 0.1).toFixed(2)) })}>
              A−
            </button>
            <button class="vd-btn" onClick={() => patchSettings({ fontScale: Math.min(2.5, +(s.fontScale + 0.1).toFixed(2)) })}>
              A+
            </button>
          </Row>
          <Row label={`${t('sync')} ${st.syncOffset > 0 ? '+' : ''}${st.syncOffset.toFixed(2)}s`}>
            <button class="vd-btn" title="[" onClick={() => ctl.nudgeSync(-0.25)}>
              −0.25
            </button>
            <button class="vd-btn" title="]" onClick={() => ctl.nudgeSync(0.25)}>
              +0.25
            </button>
          </Row>
          <Row label={t('speed')}>
            {[0.6, 0.75, 1, 1.25].map((r) => (
              <button class={`vd-btn${rate === r ? ' vd-on' : ''}`} onClick={() => ctl.setRate(r)}>
                {r}×
              </button>
            ))}
          </Row>
          <Row label={t('loadFile')}>
            <button class="vd-btn" onClick={() => loadFile('primary')}>
              {t('subsShort')}
            </button>
            <button class="vd-btn" onClick={() => loadFile('translation')}>
              {t('transShort')}
            </button>
          </Row>
          <div class="vd-keys">{t('shortcutsHelp')}</div>
        </div>
      )}
    </div>
  );
}

function Check({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label class="vd-check">
      <input type="checkbox" checked={value} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
      <span>{label}</span>
    </label>
  );
}

function Row({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="vd-row">
      <span>{label}</span>
      <div class="vd-row-btns">{children}</div>
    </div>
  );
}

function Toast({ ctl }: { ctl: SubtitleController }) {
  const toast = useStore(ctl.store, (x) => x.toast);
  if (!toast) return null;
  return (
    <div class={`vd-toast${toast.error ? ' vd-toast-err' : ''}`} key={toast.id}>
      {toast.text}
    </div>
  );
}
