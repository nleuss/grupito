// The word card (dictionary + AI explanation) shared by the video overlay and the book reader.
import type { ExplainResult, LookupResult } from '../shared/types';
import { googleCode } from '../shared/languages';
import { t } from './i18n';

export interface WordCardData {
  word: string;
  lemma?: string;
  reading?: string;
  sentence: string;
  loading: boolean;
  error?: string;
  lookup?: LookupResult;
  explaining?: boolean;
  explain?: ExplainResult & { bookNote?: string };
  explainError?: string;
  saved?: boolean;
}

export interface WordCardProps {
  data: WordCardData;
  lang: string;
  nativeLang: string;
  aiAvailable: boolean;
  explainLabel?: string;
  style: Record<string, string>;
  below?: boolean;
  onSpeak(): void;
  onSave(): void;
  onExplain(): void;
  onClose(): void;
}

export function WordCard({ data, lang, nativeLang, aiAvailable, explainLabel, style, below, onSpeak, onSave, onExplain, onClose }: WordCardProps) {
  const lk = data.lookup;
  const ex = data.explain;
  const reading = data.reading && data.reading !== data.word ? data.reading : lk?.romanization;
  const gt = `https://translate.google.com/?sl=${googleCode(lang)}&tl=${googleCode(nativeLang)}&text=${encodeURIComponent(data.sentence)}&op=translate`;
  const wk = `https://en.wiktionary.org/wiki/${encodeURIComponent(data.lemma ?? data.word)}`;

  return (
    <div
      class={`vd-pop${below ? ' vd-pop-below' : ''}`}
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div class="vd-pop-head">
        <div class="vd-pop-title">
          <span class="vd-pop-word" lang={lang}>
            {data.word}
          </span>
          {reading && <span class="vd-pop-reading">{reading}</span>}
        </div>
        <button class="vd-ib" title={t('listen')} onClick={onSpeak}>
          🔊
        </button>
        <button class={`vd-ib${data.saved ? ' vd-on' : ''}`} title={data.saved ? t('saved') : t('save')} onClick={onSave}>
          {data.saved ? '★' : '☆'}
        </button>
        <button class="vd-ib" title={t('close')} onClick={onClose}>
          ✕
        </button>
      </div>
      <div class="vd-pop-body">
        {data.lemma && (
          <div class="vd-pop-lemma">
            {t('lemma')}: <b lang={lang}>{data.lemma}</b>
          </div>
        )}
        {data.loading ? (
          <div class="vd-pop-loading">
            <span class="vd-spin" /> {t('lookingUp')}
          </div>
        ) : data.error ? (
          <div class="vd-err">
            {t('lookupFailed')}: {data.error}
          </div>
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
              {ex.bookNote && (
                <div class="vd-x-row">
                  <b>{t('inThisBook')}</b> {ex.bookNote}
                </div>
              )}
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
            <button class="vd-btn vd-ai" disabled={!aiAvailable || data.explaining} onClick={onExplain}>
              {data.explaining ? (
                <>
                  <span class="vd-spin" /> {t('explaining')}
                </>
              ) : (
                `✨ ${explainLabel ?? t('explainAi')}`
              )}
            </button>
          )}
          {!aiAvailable && !ex && <div class="vd-hint">{t('noAiKey')}</div>}
          {data.explainError && <div class="vd-err">{data.explainError}</div>}
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
