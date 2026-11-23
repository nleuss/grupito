// Book reader: PDF / EPUB / TXT with clickable words, paragraph translations and AI explanations
// that know the whole book (Claude reads it once and writes reading notes).
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import type { LineAnalysis, Settings, Token } from '../../shared/types';
import type { Book, BookSummary, Paragraph, ParsedBook } from '../../books/types';
import { deleteBook, getBook, listBooks, saveBook, updateBook } from '../../books/store';
import { bookText, capSections, parsePlainText, passageAround, sentenceAt } from '../../books/text-utils';
import { parseEpub, htmlToParagraphs } from '../../books/epub';
import { loadSecrets } from '../../shared/settings';
import { addVocab, normalizeWord, onVocabChanged, savedWordSet } from '../../shared/vocab';
import { baseLang, languageName } from '../../shared/languages';
import { clamp, errorMessage, hashString } from '../../shared/util';
import { runtimeServices } from '../../ui/services';
import { analyzeLocal } from '../../text/tokenize';
import { readTextFile } from '../../ui/files';
import { speak } from '../../ui/speech';
import { t, uiLang } from '../../ui/i18n';
import { WordCard, type WordCardData } from '../../ui/word-card';
import { digestBook, estimateDigestCost, explainInBook, translationContext, type BookMeta } from '../../ai/claude-book';
import { CLAUDE_MODELS } from '../../background/claude-models';
import { Brand, LanguageSelect, mount, toast, useSettings } from '../shared';
import overlayCss from '../../ui/overlay.css';

const style = document.createElement('style');
style.textContent = overlayCss;
document.head.appendChild(style);

// ---------------------------------------------------------------- reader preferences (per device)

interface Prefs {
  showTranslation: boolean;
  blur: boolean;
  font: number;
  serif: boolean;
}
const PREFS_KEY = 'vidioma.reader';
function loadPrefs(): Prefs {
  const d: Prefs = { showTranslation: false, blur: false, font: 1, serif: true };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
  } catch {
    return d;
  }
}
function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

// ---------------------------------------------------------------- file import

async function parseFile(file: Blob & { name: string }, onProgress: (msg: string) => void): Promise<{ parsed: ParsedBook; format: Book['format'] }> {
  const name = file.name.replace(/\.[^.]+$/, '');
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'pdf' || file.type === 'application/pdf') {
    const { parsePdf } = await import('../../books/pdf');
    return { parsed: await parsePdf(await file.arrayBuffer(), name, (d, n) => onProgress(`${d}/${n}`)), format: 'pdf' };
  }
  if (ext === 'epub' || file.type === 'application/epub+zip') return { parsed: parseEpub(new Uint8Array(await file.arrayBuffer()), name), format: 'epub' };
  if (ext === 'html' || ext === 'htm' || file.type === 'text/html') {
    const doc = new DOMParser().parseFromString(await readTextFile(file), 'text/html');
    const paragraphs = htmlToParagraphs(doc.body);
    const sections: { title: string; paragraphs: Paragraph[] }[] = [];
    for (const p of paragraphs) {
      if ((p.h === 1 || p.h === 2) && sections.length && sections[sections.length - 1].paragraphs.some((x) => !x.h)) sections.push({ title: p.t.slice(0, 80), paragraphs: [] });
      if (!sections.length) sections.push({ title: doc.title || name, paragraphs: [] });
      sections[sections.length - 1].paragraphs.push(p);
    }
    return { parsed: { title: doc.title || name, lang: doc.documentElement.lang || undefined, sections: capSections(sections) }, format: 'html' };
  }
  return { parsed: parsePlainText(await readTextFile(file), name), format: 'txt' };
}

async function addBook(parsed: ParsedBook, format: Book['format'], source: string, settings: Settings): Promise<Book> {
  const chars = parsed.sections.reduce((a, s) => a + s.paragraphs.reduce((b, p) => b + p.t.length, 0), 0);
  if (!chars) throw new Error('No text found in this file.');
  const id = `b_${hashString(`${source}|${parsed.title}|${chars}`)}`;
  const existing = await getBook(id);
  if (existing) return (await updateBook(id, { openedAt: Date.now() }))!;
  const book: Book = {
    id,
    title: parsed.title,
    author: parsed.author,
    lang: parsed.lang ? baseLang(parsed.lang) : settings.targetLang,
    format,
    sections: parsed.sections.filter((s) => s.paragraphs.length),
    chars,
    addedAt: Date.now(),
    openedAt: Date.now(),
    position: { section: 0, paragraph: 0 },
  };
  return saveBook(book);
}

// ---------------------------------------------------------------- app

function ReaderApp({ settings, patch }: { settings: Settings; patch: (p: Partial<Settings>) => Promise<void> }) {
  const [books, setBooks] = useState<BookSummary[] | null>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const remoteUrl = new URLSearchParams(location.search).get('url');

  const refresh = () => listBooks().then(setBooks);
  useEffect(() => {
    refresh();
  }, []);

  const importBlob = async (file: Blob & { name: string }, source: string) => {
    setBusy(t('parsingBook', file.name));
    try {
      const { parsed, format } = await parseFile(file, (p) => setBusy(`${t('parsingBook', file.name)} ${p}`));
      setBook(await addBook(parsed, format, source, settings));
    } catch (e) {
      toast(errorMessage(e), true);
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const openRemote = async () => {
    if (!remoteUrl) return;
    try {
      const origin = `${new URL(remoteUrl).origin}/*`;
      if (/^https?:/.test(remoteUrl) && !(await chrome.permissions.contains({ origins: [origin] })) && !(await chrome.permissions.request({ origins: [origin] }))) throw new Error('Permission denied');
      const res = await fetch(remoteUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const name = decodeURIComponent(new URL(remoteUrl).pathname.split('/').pop() || 'document.pdf');
      await importBlob(Object.assign(blob, { name }), remoteUrl);
    } catch (e) {
      toast(errorMessage(e), true);
    }
  };

  if (book) return <BookView key={book.id} initial={book} settings={settings} patch={patch} onClose={() => (setBook(null), refresh())} />;

  return (
    <div
      class={`library${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => e.target === e.currentTarget && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer?.files?.[0];
        if (f) importBlob(f, `${f.name}:${f.size}`);
      }}
    >
      <header class="bar">
        <Brand>
          <span class="muted"> · {t('readerTitle')}</span>
        </Brand>
        <span class="spacer" />
        <label class="btn primary">
          {t('openBook')}
          <input
            type="file"
            accept=".pdf,.epub,.txt,.md,.html,.htm,application/pdf,application/epub+zip,text/plain"
            hidden
            onChange={(e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (f) importBlob(f, `${f.name}:${f.size}`);
            }}
          />
        </label>
      </header>
      <main class="lib-main">
        {remoteUrl && (
          <div class="card remote">
            <button class="btn primary" onClick={openRemote} disabled={!!busy}>
              📖 {t('openPdfFromWeb', decodeURIComponent(remoteUrl.split('/').pop()?.split('?')[0] || remoteUrl))}
            </button>
          </div>
        )}
        {busy && (
          <div class="card busy">
            <span class="spin" /> {busy}
          </div>
        )}
        <div class="drop card">{t('readerDrop')}</div>
        <h2>{t('library')}</h2>
        {books && !books.length && <p class="muted">{t('emptyLibrary')}</p>}
        <div class="books">
          {books?.map((b) => (
            <div class="card book" key={b.id}>
              <div class="book-title" lang={b.lang}>
                {b.title}
              </div>
              <div class="muted small">
                {[b.author, b.format.toUpperCase(), languageName(b.lang, uiLang())].filter(Boolean).join(' · ')}
                {b.hasDigest ? ' · ✨' : ''}
              </div>
              <div class="progress">
                <div style={{ width: `${Math.round(b.progress * 100)}%` }} />
              </div>
              <div class="row">
                <span class="muted small">{t('readProgress', Math.round(b.progress * 100))}</span>
                <span class="spacer" />
                <button
                  class="btn small ghost danger"
                  onClick={async () => {
                    if (!confirm(t('confirmDeleteBook', b.title))) return;
                    await deleteBook(b.id);
                    refresh();
                  }}
                >
                  {t('deleteBook')}
                </button>
                <button
                  class="btn small primary"
                  onClick={async () => {
                    const full = await updateBook(b.id, { openedAt: Date.now() });
                    if (full) setBook(full);
                  }}
                >
                  {t('continueReading')}
                </button>
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------- book view

interface CardState extends WordCardData {
  pi: number;
  phrase?: boolean;
  left: number;
  top: number;
  below: boolean;
}

interface ParagraphProps {
  p: Paragraph;
  i: number;
  lang: string;
  analysis: LineAnalysis;
  translation?: string;
  showTranslation: boolean;
  blur: boolean;
  ruby: boolean;
  saved: Set<string>;
  selected?: number;
  onWord: (e: MouseEvent, pi: number, ti: number, tokens: Token[]) => void;
  onSpeak: (text: string) => void;
  onTranslate: (pi: number) => void;
}

const ParagraphView = memo(function ParagraphView({ p, i, lang, analysis, translation, showTranslation, blur, ruby, saved, selected, onWord, onSpeak, onTranslate }: ParagraphProps) {
  const Tag = p.h === 1 ? 'h2' : p.h ? 'h3' : 'p';
  return (
    <div class={`rd-p${p.h ? ' rd-h' : ''}`} data-i={i}>
      <Tag class="rd-text" lang={lang} dir="auto">
        {analysis.tokens.map((tk, ti) =>
          tk.word ? (
            <span key={ti} class={`rd-w${saved.has(normalizeWord(tk.text)) || (tk.lemma && saved.has(normalizeWord(tk.lemma))) ? ' saved' : ''}${selected === ti ? ' sel' : ''}`} onClick={(e) => onWord(e as unknown as MouseEvent, i, ti, analysis.tokens)}>
              {ruby && tk.ruby?.some((r) => r.rt) ? tk.ruby.map((r, k) => (r.rt ? <ruby key={k}>{r.base}<rt>{r.rt}</rt></ruby> : <span key={k}>{r.base}</span>)) : tk.text}
            </span>
          ) : (
            <span key={ti}>{tk.text}</span>
          ),
        )}
      </Tag>
      {showTranslation && translation !== undefined && (
        <div class={`rd-tr${blur ? ' blur' : ''}`} dir="auto">
          {translation || '…'}
        </div>
      )}
      <div class="rd-tools">
        <button class="btn ghost small" title={t('readAloud')} onClick={() => onSpeak(p.t)}>
          🔊
        </button>
        {!showTranslation && (
          <button class="btn ghost small" title={t('translateParagraph')} onClick={() => onTranslate(i)}>
            🌐
          </button>
        )}
      </div>
    </div>
  );
});

function BookView({ initial, settings, patch, onClose }: { initial: Book; settings: Settings; patch: (p: Partial<Settings>) => Promise<void>; onClose: () => void }) {
  const [book, setBook] = useState(initial);
  const [sec, setSec] = useState(Math.min(initial.position.section, initial.sections.length - 1));
  const [prefs, setPrefsState] = useState(loadPrefs);
  const [showToc, setShowToc] = useState(window.innerWidth > 1000);
  const [showAbout, setShowAbout] = useState(false);
  const [card, setCard] = useState<CardState | null>(null);
  const [sel, setSel] = useState<{ text: string; x: number; y: number; pi: number } | null>(null);
  const [version, setVersion] = useState(0);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [aiKey, setAiKey] = useState('');
  const [digestRun, setDigestRun] = useState<{ running: boolean; progress?: string; error?: string }>({ running: false });
  const translations = useRef(new Map<string, string>());
  const analyses = useRef(new Map<string, LineAnalysis>());
  const forced = useRef(new Set<number>());
  const visible = useRef(new Set<number>());
  const textRef = useRef<HTMLDivElement>(null);
  const section = book.sections[sec];
  const lang = book.lang;
  const native = settings.nativeLang;
  const meta: BookMeta = { title: book.title, author: book.author, lang };
  const isCjk = ['ja', 'zh'].includes(baseLang(lang));

  const setPrefs = (p: Partial<Prefs>) =>
    setPrefsState((cur) => {
      const next = { ...cur, ...p };
      savePrefs(next);
      return next;
    });

  useEffect(() => {
    document.title = `${book.title} · Vidioma`;
    loadSecrets().then((s) => setAiKey(s.claudeKey || (__TEST__ && settings.translationProvider === 'mock' ? 'mock' : '')));
    const loadSaved = () => savedWordSet(lang).then(setSaved);
    loadSaved();
    return onVocabChanged(loadSaved);
  }, [lang]);

  // ---------------------------------------------------- work queues (translations, ja/zh analysis)
  const inflight = useRef({ tr: false, an: false, failures: 0 });
  const pump = useCallback(() => {
    const wantTr = prefs.showTranslation ? [...visible.current] : [];
    const indices = [...new Set([...wantTr, ...forced.current])].sort((a, b) => a - b);
    const trTodo = indices.map((i) => section.paragraphs[i]?.t).filter((x): x is string => !!x && !translations.current.has(x));
    if (trTodo.length && !inflight.current.tr) {
      const batch: string[] = [];
      let len = 0;
      for (const x of trTodo) {
        if (batch.length && (batch.length >= 12 || len + x.length > 6000)) break;
        batch.push(x);
        len += x.length;
      }
      inflight.current.tr = true;
      runtimeServices
        .translate(batch, lang, native, settings, book.title, translationContext(meta, book.digest))
        .then((res) => {
          batch.forEach((x, k) => translations.current.set(x, res[k] ?? ''));
          inflight.current.failures = 0;
          setVersion((v) => v + 1);
        })
        .catch((e) => {
          if (++inflight.current.failures <= 2) toast(t('translateFailed', errorMessage(e)), true);
        })
        .finally(() => {
          inflight.current.tr = false;
          if (inflight.current.failures < 3) setTimeout(pump, 30);
        });
    }
    if (isCjk && !inflight.current.an) {
      const anTodo = [...visible.current].map((i) => section.paragraphs[i]?.t).filter((x): x is string => !!x && !analyses.current.has(x)).slice(0, 20);
      if (anTodo.length) {
        inflight.current.an = true;
        runtimeServices
          .analyze(anTodo, lang)
          .then((res) => {
            anTodo.forEach((x, k) => res[k] && analyses.current.set(x, res[k]));
            setVersion((v) => v + 1);
          })
          .catch(() => anTodo.forEach((x) => analyses.current.set(x, analyzeLocal(x, lang))))
          .finally(() => {
            inflight.current.an = false;
            setTimeout(pump, 30);
          });
      }
    }
  }, [section, prefs.showTranslation, lang, native, settings, book.digest]);

  // Track which paragraphs are on screen.
  useEffect(() => {
    visible.current.clear();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const i = Number((e.target as HTMLElement).dataset.i);
          if (e.isIntersecting) visible.current.add(i);
          else visible.current.delete(i);
        }
        pump();
      },
      { rootMargin: '600px 0px' },
    );
    textRef.current?.querySelectorAll('.rd-p').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [sec, pump]);

  // Restore / save the reading position.
  useEffect(() => {
    forced.current.clear();
    const target = sec === book.position.section ? book.position.paragraph : 0;
    const el = textRef.current?.querySelector(`[data-i="${target}"]`);
    if (el && target > 0) el.scrollIntoView({ block: 'start' });
    else window.scrollTo(0, 0);
  }, [sec]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const onScroll = () => {
      setCard(null);
      setSel(null);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const els = textRef.current?.querySelectorAll<HTMLElement>('.rd-p') ?? [];
        let idx = 0;
        for (const el of Array.from(els)) {
          if (el.getBoundingClientRect().bottom > 90) {
            idx = Number(el.dataset.i);
            break;
          }
        }
        const position = { section: sec, paragraph: idx };
        setBook((cur) => ({ ...cur, position }));
        updateBook(book.id, { position, openedAt: Date.now() }).catch(() => {});
      }, 600);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      clearTimeout(timer);
    };
  }, [sec, book.id]);

  // Keyboard: arrows switch chapters, Esc closes the card.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName)) return;
      if (e.key === 'Escape') {
        setCard(null);
        setSel(null);
      }
    };
    const onDown = (e: PointerEvent) => {
      const path = e.composedPath();
      if (!path.some((n) => n instanceof HTMLElement && (n.classList.contains('vd-pop') || n.classList.contains('rd-w') || n.classList.contains('sel-bar')))) setCard(null);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, []);

  // ---------------------------------------------------- word card
  const openCard = async (base: Omit<CardState, 'loading' | 'left' | 'top' | 'below'>, rect: DOMRect, thenExplain = false) => {
    const below = rect.top < 400;
    const next: CardState = {
      ...base,
      loading: true,
      left: clamp(rect.left + rect.width / 2 - 170, 8, window.innerWidth - 348),
      top: below ? rect.bottom : rect.top,
      below,
      saved: saved.has(normalizeWord(base.word)),
    };
    setCard(next);
    setSel(null);
    const matches = (c: CardState | null) => !!c && c.word === base.word && c.pi === base.pi;
    try {
      const lookup = base.phrase
        ? { word: base.word, translation: (await runtimeServices.translate([base.word], lang, native, settings, book.title))[0], entries: [], definitions: [], sources: [] }
        : await runtimeServices.lookup(base.word, base.lemma, base.sentence, lang, native);
      setCard((c) => (matches(c) ? { ...c!, loading: false, lookup } : c));
    } catch (e) {
      setCard((c) => (matches(c) ? { ...c!, loading: false, error: errorMessage(e) } : c));
    }
    if (thenExplain) explain(next);
  };

  const onWord = useCallback(
    (e: MouseEvent, pi: number, ti: number, tokens: Token[]) => {
      e.stopPropagation();
      const p = section.paragraphs[pi];
      const tk = tokens[ti];
      const offset = tokens.slice(0, ti).reduce((a, x) => a + x.text.length, 0);
      openCard(
        { word: tk.text, lemma: tk.lemma && tk.lemma !== tk.text ? tk.lemma : undefined, reading: tk.reading, sentence: sentenceAt(p.t, offset, lang), pi },
        (e.currentTarget as HTMLElement).getBoundingClientRect(),
      );
    },
    [section, lang, settings, saved],
  );

  const explain = async (c: CardState | null = card) => {
    if (!c) return;
    setCard((cur) => (cur && cur.word === c.word ? { ...cur, explaining: true, explainError: undefined } : cur));
    try {
      const ex = await explainInBook(aiKey, settings.claudeModel, meta, book.digest, native, c.word, c.sentence, passageAround(section.paragraphs, c.pi), section.title);
      setCard((cur) => (cur && cur.word === c.word ? { ...cur, explaining: false, explain: ex } : cur));
    } catch (e) {
      setCard((cur) => (cur && cur.word === c.word ? { ...cur, explaining: false, explainError: errorMessage(e) } : cur));
    }
  };

  const save = async () => {
    if (!card) return;
    const ex = card.explain;
    await addVocab({
      kind: card.phrase ? 'sentence' : 'word',
      lang,
      text: card.word,
      lemma: card.lemma ?? (ex?.lemma && ex.lemma !== card.word ? ex.lemma : undefined),
      reading: card.reading ?? (ex?.reading || card.lookup?.romanization || undefined),
      translation: card.lookup?.translation || ex?.meaning || card.lookup?.entries[0]?.terms[0],
      definition: ex?.meaning || card.lookup?.definitions.slice(0, 2).map((d) => d.text).join('; ') || undefined,
      context: card.phrase ? undefined : card.sentence,
      contextTranslation: ex?.sentenceTranslation,
      notes: ex?.bookNote || undefined,
      source: { site: 'book', title: book.title, url: '', location: `${section.title} · ¶${card.pi + 1}` },
    });
    setCard((c) => (c ? { ...c, saved: true } : c));
    toast(t('toastSaved'));
  };

  // ---------------------------------------------------- selection toolbar
  const onMouseUp = () => {
    setTimeout(() => {
      const s = window.getSelection();
      const text = s?.toString().replace(/\s+/g, ' ').trim() ?? '';
      if (!s || s.isCollapsed || text.length < 2 || text.length > 600 || !s.rangeCount) return setSel(null);
      const range = s.getRangeAt(0);
      const pEl = (range.startContainer.nodeType === 1 ? (range.startContainer as Element) : range.startContainer.parentElement)?.closest<HTMLElement>('.rd-p');
      if (!pEl) return setSel(null);
      const r = range.getBoundingClientRect();
      setSel({ text, x: r.left + r.width / 2, y: r.top, pi: Number(pEl.dataset.i) });
    }, 0);
  };

  const selectionRect = () => window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0).getBoundingClientRect() : new DOMRect(sel?.x ?? 100, sel?.y ?? 100, 1, 1);

  // ---------------------------------------------------- AI digest
  const fullText = useMemo(() => bookText(book.sections), [book.id]);
  const cost = useMemo(() => estimateDigestCost(fullText, settings.claudeModel), [fullText, settings.claudeModel]);
  const analyze = async () => {
    setDigestRun({ running: true, progress: '' });
    try {
      const digest = await digestBook(aiKey, settings.claudeModel, meta, fullText, native, (i, n) => setDigestRun({ running: true, progress: n > 1 ? `${i + 1}/${n}` : '' }));
      const updated = await updateBook(book.id, { digest });
      if (updated) setBook(updated);
      setDigestRun({ running: false });
      setShowAbout(true);
    } catch (e) {
      setDigestRun({ running: false, error: errorMessage(e) });
    }
  };

  // ---------------------------------------------------- render
  const analysisFor = (text: string): LineAnalysis => {
    const cached = analyses.current.get(text);
    if (cached) return cached;
    const local = analyzeLocal(text, lang);
    if (!isCjk) analyses.current.set(text, local);
    return local;
  };
  const total = book.sections.reduce((a, s) => a + s.paragraphs.length, 0) || 1;
  const done = book.sections.slice(0, book.position.section).reduce((a, s) => a + s.paragraphs.length, 0) + book.position.paragraph;
  const speakText = useCallback((text: string) => speak(text, lang), [lang]);
  const translateOne = useCallback(
    (pi: number) => {
      forced.current.add(pi);
      pump();
      setVersion((v) => v + 1);
    },
    [pump],
  );

  return (
    <div class={`reader${prefs.serif ? ' serif' : ''}`} style={{ '--rd-font': String(prefs.font) } as Record<string, string>}>
      <header class="bar rd-bar">
        <button class="btn ghost" onClick={onClose} title={t('library')}>
          ←
        </button>
        <button class={`btn ghost${showToc ? ' on' : ''}`} onClick={() => setShowToc(!showToc)}>
          ☰ {t('contents')}
        </button>
        <div class="rd-title" title={book.title} lang={lang}>
          {book.title}
        </div>
        <span class="spacer" />
        <label class="row small">
          <span class="muted">{t('bookLanguage')}</span>
          <LanguageSelect
            compact
            value={baseLang(lang)}
            onChange={(v) => {
              analyses.current.clear();
              translations.current.clear();
              updateBook(book.id, { lang: v }).then((b) => b && setBook(b));
            }}
          />
        </label>
        <label class="row small toggle">
          <input type="checkbox" checked={prefs.showTranslation} onChange={(e) => setPrefs({ showTranslation: (e.target as HTMLInputElement).checked })} />
          {t('showTranslations')}
        </label>
        <label class="row small toggle">
          <input type="checkbox" checked={prefs.blur} onChange={(e) => setPrefs({ blur: (e.target as HTMLInputElement).checked })} />
          {t('blurToggle')}
        </label>
        <button class="btn ghost small" onClick={() => setPrefs({ font: Math.max(0.7, +(prefs.font - 0.1).toFixed(2)) })}>
          A−
        </button>
        <button class="btn ghost small" onClick={() => setPrefs({ font: Math.min(1.8, +(prefs.font + 0.1).toFixed(2)) })}>
          A+
        </button>
        <button class={`btn ghost${showAbout ? ' on' : ''}`} onClick={() => setShowAbout(!showAbout)}>
          ✨ {t('aboutBook')}
        </button>
      </header>
      <div class="rd-progress">
        <div style={{ width: `${Math.round((done / total) * 100)}%` }} />
      </div>

      <div class="rd-body">
        {showToc && (
          <aside class="rd-side card">
            <div class="side-title">{t('contents')}</div>
            {book.sections.map((s, i) => (
              <button key={i} class={`toc${i === sec ? ' cur' : ''}`} onClick={() => setSec(i)}>
                {s.title}
              </button>
            ))}
          </aside>
        )}

        <main class="rd-main" ref={textRef} onMouseUp={onMouseUp}>
          <div class="rd-section-title">{section.title}</div>
          {section.paragraphs.map((p, i) => (
            <ParagraphView
              key={`${sec}-${i}`}
              p={p}
              i={i}
              lang={lang}
              analysis={analysisFor(p.t)}
              translation={translations.current.get(p.t)}
              showTranslation={prefs.showTranslation || forced.current.has(i)}
              blur={prefs.blur}
              ruby={settings.rubyReadings}
              saved={saved}
              onWord={onWord}
              onSpeak={speakText}
              onTranslate={translateOne}
            />
          ))}
          <div class="rd-nav">
            <button class="btn" disabled={sec === 0} onClick={() => setSec(sec - 1)}>
              ← {t('prevChapter')}
            </button>
            <span class="muted small">
              {sec + 1} / {book.sections.length}
            </span>
            <button class="btn primary" disabled={sec >= book.sections.length - 1} onClick={() => setSec(sec + 1)}>
              {t('nextChapter')} →
            </button>
          </div>
          <span hidden>{version}</span>
        </main>

        {showAbout && (
          <aside class="rd-side rd-about card">
            <div class="side-title">✨ {t('aboutBook')}</div>
            {book.digest ? (
              <>
                <section>
                  <h4>{t('premise')}</h4>
                  <p>{book.digest.premise}</p>
                </section>
                {book.digest.characters.length > 0 && (
                  <section>
                    <h4>{t('characters')}</h4>
                    <dl>
                      {book.digest.characters.map((c) => (
                        <>
                          <dt lang={lang}>{c.name}</dt>
                          <dd>{c.description}</dd>
                        </>
                      ))}
                    </dl>
                  </section>
                )}
                {book.digest.glossary.length > 0 && (
                  <section>
                    <h4>{t('glossary')}</h4>
                    <dl>
                      {book.digest.glossary.map((g) => (
                        <>
                          <dt lang={lang}>{g.term}</dt>
                          <dd>{g.meaning}</dd>
                        </>
                      ))}
                    </dl>
                  </section>
                )}
                {book.digest.places.length > 0 && (
                  <section>
                    <h4>{t('places')}</h4>
                    <dl>
                      {book.digest.places.map((g) => (
                        <>
                          <dt lang={lang}>{g.name}</dt>
                          <dd>{g.description}</dd>
                        </>
                      ))}
                    </dl>
                  </section>
                )}
                <section>
                  <h4>{t('styleNotes')}</h4>
                  <p>{book.digest.style}</p>
                </section>
                <details>
                  <summary>{t('fullSummary')}</summary>
                  <p>{book.digest.summary}</p>
                </details>
                <p class="muted small">
                  {t('bookAnalyzed', CLAUDE_MODELS.find((m) => m.id === book.digest!.model)?.label ?? book.digest.model)} ·{' '}
                  <button class="link" disabled={digestRun.running || !aiKey} onClick={analyze}>
                    {t('reanalyze')}
                  </button>
                </p>
              </>
            ) : (
              <>
                <p class="small">{t('analyzeHint', CLAUDE_MODELS.find((m) => m.id === settings.claudeModel)?.label ?? settings.claudeModel, cost.usd.toFixed(2), cost.tokens.toLocaleString())}</p>
                <button class="btn primary wide" disabled={digestRun.running || !aiKey} onClick={analyze}>
                  {digestRun.running ? (
                    <>
                      <span class="spin" /> {t('analyzing', digestRun.progress ?? '')}
                    </>
                  ) : (
                    `✨ ${t('analyzeBook')}`
                  )}
                </button>
                {!aiKey && <p class="muted small">{t('aiNeedsClaude')}</p>}
                <label class="small row model">
                  <span class="muted">{t('claudeModel')}</span>
                  <select class="input" value={settings.claudeModel} onChange={(e) => patch({ claudeModel: (e.target as HTMLSelectElement).value })}>
                    {CLAUDE_MODELS.map((m) => (
                      <option value={m.id}>{m.label}</option>
                    ))}
                  </select>
                </label>
              </>
            )}
            {digestRun.error && <p class="error small">{digestRun.error}</p>}
          </aside>
        )}
      </div>

      {sel && (
        <div class="sel-bar card" style={{ left: `${clamp(sel.x - 150, 8, window.innerWidth - 308)}px`, top: `${Math.max(8, sel.y - 48)}px` }} onPointerDown={(e) => e.preventDefault()}>
          <button class="btn small" onClick={() => openCard({ word: sel.text, sentence: sel.text, pi: sel.pi, phrase: true }, selectionRect())}>
            🌐 {t('translateSelection')}
          </button>
          <button class="btn small" disabled={!aiKey} onClick={() => openCard({ word: sel.text, sentence: sentenceAt(section.paragraphs[sel.pi]?.t ?? sel.text, Math.max(0, (section.paragraphs[sel.pi]?.t ?? '').indexOf(sel.text)), lang), pi: sel.pi, phrase: true }, selectionRect(), true)}>
            ✨ {t('explainSelection')}
          </button>
        </div>
      )}

      {card && (
        <div class="vd-root rd-layer">
          <WordCard
            data={card}
            lang={lang}
            nativeLang={native}
            aiAvailable={!!aiKey}
            explainLabel={t('explainInBook')}
            below={card.below}
            style={{ left: `${card.left}px`, top: `${card.top}px` }}
            onSpeak={() => speak(card.lemma ?? card.word, lang)}
            onSave={save}
            onExplain={() => explain()}
            onClose={() => setCard(null)}
          />
        </div>
      )}
    </div>
  );
}

function Reader() {
  const [settings, patch] = useSettings();
  if (!settings) return <div class="muted" style={{ padding: 20 }}>…</div>;
  return <ReaderApp settings={settings} patch={patch} />;
}

mount(<Reader />);
