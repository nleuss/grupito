import { useEffect, useMemo, useState } from 'preact/hooks';
import type { VocabItem, VocabStatus } from '../../shared/types';
import { deleteVocab, listVocab, onVocabChanged, updateVocab } from '../../shared/vocab';
import { baseLang, languageName } from '../../shared/languages';
import { downloadBlob, errorMessage, formatTime, safeFilename } from '../../shared/util';
import { t, uiLang } from '../../ui/i18n';
import { speak } from '../../ui/speech';
import { vocabToCsv } from '../../export/csv';
import { buildApkg } from '../../export/apkg';
import { vocabTags, vocabToFields } from '../../export/anki-model';
import { sendNotesToAnki } from '../../export/ankiconnect';
import { Brand, mount, toast, useSettings } from '../shared';

const STATUSES: VocabStatus[] = ['new', 'learning', 'known'];
const statusLabel = (s: VocabStatus) => t(s === 'new' ? 'statusNew' : s === 'learning' ? 'statusLearning' : 'statusKnown');

function Editable({ value, onSave, placeholder, lang }: { value: string; onSave: (v: string) => void; placeholder?: string; lang?: string }) {
  return (
    <div
      class="editable"
      contentEditable
      lang={lang}
      data-placeholder={placeholder}
      onBlur={(e) => {
        const v = (e.target as HTMLElement).innerText.trim();
        if (v !== value) onSave(v);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          (e.target as HTMLElement).blur();
        }
      }}
      dangerouslySetInnerHTML={{ __html: value.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!) }}
    />
  );
}

function Vocab() {
  const [settings] = useSettings();
  const [items, setItems] = useState<VocabItem[] | null>(null);
  const [q, setQ] = useState('');
  const [lang, setLang] = useState('');
  const [status, setStatus] = useState<'' | VocabStatus>('');
  const [kind, setKind] = useState<'' | 'word' | 'sentence'>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const load = () => listVocab().then(setItems);
    load();
    return onVocabChanged(load);
  }, []);

  const langs = useMemo(() => [...new Set((items ?? []).map((i) => baseLang(i.lang)))].sort(), [items]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (items ?? []).filter(
      (i) =>
        (!lang || baseLang(i.lang) === lang) &&
        (!status || i.status === status) &&
        (!kind || i.kind === kind) &&
        (!needle || [i.text, i.translation, i.context, i.notes, i.source?.title].some((f) => f?.toLowerCase().includes(needle))),
    );
  }, [items, q, lang, status, kind]);

  const target = selected.size ? filtered.filter((i) => selected.has(i.id)) : filtered;
  const allChecked = filtered.length > 0 && filtered.every((i) => selected.has(i.id));
  const deck = settings?.ankiDeck || 'Vidioma';

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(errorMessage(e), true);
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = () => downloadBlob(new Blob([vocabToCsv(target)], { type: 'text/csv;charset=utf-8' }), `vidioma-${new Date().toISOString().slice(0, 10)}.csv`);
  const exportApkg = () =>
    run(async () => {
      const bytes = await buildApkg(
        deck,
        target.map((v) => ({ fields: vocabToFields(v), tags: vocabTags(v) })),
      );
      downloadBlob(new Blob([bytes], { type: 'application/octet-stream' }), `${safeFilename(deck)}.apkg`);
    });
  const sendAnki = () =>
    run(async () => {
      try {
        const n = await sendNotesToAnki(
          deck,
          target.map((v) => ({ fields: vocabToFields(v), tags: vocabTags(v) })),
        );
        toast(t('sentAnki', n));
      } catch (e) {
        throw new Error(/fetch|network|Failed/i.test(errorMessage(e)) ? t('ankiError') : errorMessage(e));
      }
    });
  const remove = () =>
    run(async () => {
      if (!confirm(t('confirmDelete', target.length))) return;
      await deleteVocab(target.map((i) => i.id));
      setSelected(new Set());
    });

  return (
    <div class="page">
      <header class="top row">
        <Brand>
          <span class="muted"> · {t('vocabTitle')}</span>
        </Brand>
        <span class="spacer" />
        <span class="muted small">{items ? `${filtered.length} / ${items.length}` : ''}</span>
      </header>

      <div class="toolbar card">
        <input class="input search" placeholder={t('search')} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        <select class="input" value={lang} onChange={(e) => setLang((e.target as HTMLSelectElement).value)}>
          <option value="">{t('allLanguages')}</option>
          {langs.map((l) => (
            <option value={l}>{languageName(l, uiLang())}</option>
          ))}
        </select>
        <select class="input" value={kind} onChange={(e) => setKind((e.target as HTMLSelectElement).value as typeof kind)}>
          <option value="">{t('all')}</option>
          <option value="word">{t('words')}</option>
          <option value="sentence">{t('sentences')}</option>
        </select>
        <select class="input" value={status} onChange={(e) => setStatus((e.target as HTMLSelectElement).value as typeof status)}>
          <option value="">{t('allStatus')}</option>
          {STATUSES.map((s) => (
            <option value={s}>{statusLabel(s)}</option>
          ))}
        </select>
        <span class="spacer" />
        {selected.size > 0 && <span class="muted small">{t('selected', selected.size)}</span>}
        <button class="btn" disabled={busy || !target.length} onClick={exportCsv}>
          {t('exportCsv')}
        </button>
        <button class="btn" disabled={busy || !target.length} onClick={exportApkg}>
          {t('exportApkg')}
        </button>
        <button class="btn primary" disabled={busy || !target.length} onClick={sendAnki}>
          {t('sendAnki')}
        </button>
        {selected.size > 0 && (
          <button class="btn danger" disabled={busy} onClick={remove}>
            {t('deleteSelected')}
          </button>
        )}
      </div>

      {items && items.length === 0 ? (
        <div class="empty card">{t('emptyVocab')}</div>
      ) : (
        <div class="card table-wrap">
          <table class="vocab">
            <thead>
              <tr>
                <th class="check">
                  <input type="checkbox" checked={allChecked} onChange={() => setSelected(allChecked ? new Set() : new Set(filtered.map((i) => i.id)))} />
                </th>
                <th>{t('colWord')}</th>
                <th>{t('colTranslation')}</th>
                <th>{t('colContext')}</th>
                <th>{t('colSource')}</th>
                <th>{t('colStatus')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((v) => (
                <tr key={v.id} class={selected.has(v.id) ? 'sel' : ''}>
                  <td class="check">
                    <input type="checkbox" checked={selected.has(v.id)} onChange={() => toggle(v.id)} />
                  </td>
                  <td class="word">
                    <div class="row">
                      <button class="btn ghost small" title={t('listen')} onClick={() => speak(v.text, v.lang)}>
                        🔊
                      </button>
                      <div>
                        <div class={v.kind === 'word' ? 'w' : 's'} lang={v.lang}>
                          {v.text}
                        </div>
                        <div class="muted small">
                          {[v.reading, v.lemma && v.lemma !== v.text ? v.lemma : '', languageName(v.lang, uiLang())].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <Editable value={v.translation ?? ''} onSave={(x) => updateVocab(v.id, { translation: x })} placeholder="—" />
                    {v.definition && <div class="muted small def">{v.definition}</div>}
                  </td>
                  <td class="ctx">
                    {v.context && (
                      <div lang={v.lang} dir="auto">
                        {v.context}
                      </div>
                    )}
                    {v.contextTranslation && <div class="muted small">{v.contextTranslation}</div>}
                  </td>
                  <td class="src small">
                    {v.source?.url ? (
                      <a href={v.source.url} target="_blank" rel="noreferrer">
                        {v.source.title || v.source.site}
                      </a>
                    ) : (
                      v.source?.title
                    )}
                    {v.source?.time != null && <div class="muted">{formatTime(v.source.time)}</div>}
                    {v.source?.location && <div class="muted">{v.source.location}</div>}
                  </td>
                  <td>
                    <select class="input status" value={v.status} onChange={(e) => updateVocab(v.id, { status: (e.target as HTMLSelectElement).value as VocabStatus })}>
                      {STATUSES.map((s) => (
                        <option value={s}>{statusLabel(s)}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

mount(<Vocab />);
