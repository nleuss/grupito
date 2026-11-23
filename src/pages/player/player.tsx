// Local video player: your own video files + subtitle files (or AI transcription),
// dual subtitles, clickable words, transcript and Anki deck generation with audio + screenshots.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Cue, Settings } from '../../shared/types';
import { loadSecrets } from '../../shared/settings';
import { listVocab } from '../../shared/vocab';
import { downloadBlob, errorMessage, escapeHtml, formatTime, mapLimit, safeFilename } from '../../shared/util';
import { SubtitleController, type PlayerHost } from '../../ui/controller';
import { runtimeServices } from '../../ui/services';
import { Overlay, Transcript } from '../../ui/overlay';
import { useStore } from '../../shared/store';
import { t } from '../../ui/i18n';
import { readTextFile, pickFile, SUBTITLE_ACCEPT } from '../../ui/files';
import { detectFormat } from '../../subtitles/parsers';
import { toSrt } from '../../subtitles/cues';
import { cueToSingleLine } from '../../subtitles/text';
import { Chunker, encodeWav, type AudioChunk } from '../../ai/audio';
import { transcribe } from '../../ai/stt';
import { clip, decodeAudio, encodeMp3, FrameGrabber } from '../../export/media';
import { buildApkg, type ApkgMedia, type ApkgNote } from '../../export/apkg';
import { Brand, mount, toast, useSettings } from '../shared';
import overlayCss from '../../ui/overlay.css';

const style = document.createElement('style');
style.textContent = overlayCss;
document.head.appendChild(style);

const VIDEO_EXT = /\.(mp4|m4v|webm|mkv|mov|ogv|ogg|mp3|m4a|wav|flac|opus)$/i;

function PlayerApp({ settings, patch }: { settings: Settings; patch: (p: Partial<Settings>) => Promise<void> }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<File | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [src, setSrc] = useState('');
  const [aiProgress, setAiProgress] = useState<number | null>(null);
  const [deckOpen, setDeckOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [ytUrl, setYtUrl] = useState('');

  const ctl = useMemo(() => {
    const host: PlayerHost = {
      getVideo: () => videoRef.current,
      seek: (time) => {
        if (videoRef.current) videoRef.current.currentTime = Math.max(0, time);
      },
      timeOffset: () => 0,
      videoInfo: () => (fileRef.current ? { site: 'local', id: `${fileRef.current.name}:${fileRef.current.size}`, title: fileRef.current.name, url: '' } : null),
      loadTrack: async (track) => (track.data as { cues?: Cue[] } | undefined)?.cues ?? [],
    };
    return new SubtitleController(host, runtimeServices, settings);
  }, []);

  useEffect(() => ctl.updateSettings(settings), [settings]);
  useEffect(() => {
    ctl.start();
    return () => ctl.stop();
  }, []);

  const st = useStore(ctl.store, (x) => ({ tracks: x.tracks, primaryId: x.primaryId, translationId: x.translationId, cues: x.cues, status: x.status, message: x.message, rate: x.rate }));

  // Keep the overlay over the visible picture (letterboxing) and give it the video height for font sizing.
  useEffect(() => {
    const v = videoRef.current;
    const o = overlayRef.current;
    if (!v || !o) return;
    const place = () => {
      const W = v.clientWidth;
      const H = v.clientHeight;
      let w = W;
      let h = H;
      if (v.videoWidth && v.videoHeight) {
        const scale = Math.min(W / v.videoWidth, H / v.videoHeight);
        w = v.videoWidth * scale;
        h = v.videoHeight * scale;
      }
      Object.assign(o.style, { left: `${v.offsetLeft + (W - w) / 2}px`, top: `${v.offsetTop + (H - h) / 2}px`, width: `${w}px`, height: `${h}px` });
      o.style.setProperty('--vd-h', `${h}px`);
    };
    const ro = new ResizeObserver(place);
    ro.observe(v);
    v.addEventListener('loadedmetadata', place);
    place();
    return () => {
      ro.disconnect();
      v.removeEventListener('loadedmetadata', place);
    };
  }, [src]);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable) return;
      if (e.key === ' ' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        ctl.togglePlay();
        return;
      }
      if (ctl.state.cues.length && ctl.handleKey(e, (p) => void patch(p))) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openVideo = (f: File) => {
    if (src) URL.revokeObjectURL(src);
    fileRef.current = f;
    setFile(f);
    setSrc(URL.createObjectURL(f));
    ctl.reset();
    document.title = `${f.name} · Vidioma`;
  };

  const loadSubtitle = async (f: File, as: 'primary' | 'translation') => {
    try {
      const text = await readTextFile(f);
      if (!detectFormat(text)) throw new Error(`${f.name}: unknown subtitle format`);
      ctl.addFileTrack(f.name, text, as, guessLangFromName(f.name, as === 'primary' ? settings.targetLang : settings.nativeLang));
    } catch (e) {
      toast(errorMessage(e), true);
    }
  };

  const onFiles = async (files: File[]) => {
    const video = files.find((f) => VIDEO_EXT.test(f.name) || f.type.startsWith('video/') || f.type.startsWith('audio/'));
    if (video) openVideo(video);
    const subs = files.filter((f) => f !== video);
    for (const [i, f] of subs.entries()) await loadSubtitle(f, i === 0 && !ctl.state.primaryId ? 'primary' : 'translation');
  };

  const transcribeFile = async () => {
    if (!file) return;
    const secrets = await loadSecrets();
    const base = settings.sttBaseUrl.replace(/\/+$/, '');
    try {
      if (!secrets.sttKey && !/localhost|127\.0\.0\.1/.test(base)) throw new Error(t('aiNeedsKey'));
      const origin = `${new URL(base).origin}/*`;
      if (!(await chrome.permissions.contains({ origins: [origin] })) && !(await chrome.permissions.request({ origins: [origin] }))) throw new Error('Permission denied');
      setAiProgress(0);
      let samples: Float32Array;
      try {
        samples = await decodeAudio(file, 16000);
      } catch (e) {
        throw new Error(t('audioDecodeFailed', errorMessage(e)));
      }
      const chunks: AudioChunk[] = [];
      const chunker = new Chunker({ sampleRate: 16000, minSec: 25, maxSec: 75, silenceRms: 0.006, silenceMs: 350 }, (c) => chunks.push(c), 1 / 16000);
      for (let i = 0; i < samples.length; i += 160000) chunker.push(samples.subarray(i, i + 160000), i / 16000);
      chunker.flush();
      const voiced = chunks.filter((c) => !c.silent);
      const total = voiced.reduce((a, c) => a + c.samples.length, 0) || 1;
      let done = 0;
      await mapLimit(voiced, 3, async (c) => {
        const dur = c.samples.length / 16000;
        const segs = await transcribe(encodeWav(c.samples), dur, { baseUrl: base, model: settings.sttModel, key: secrets.sttKey }, settings.targetLang);
        ctl.addAiCues(segs.map((s) => ({ start: c.start + s.start, end: c.start + s.end, text: s.text })));
        done += c.samples.length;
        setAiProgress(Math.round((done / total) * 100));
      });
    } catch (e) {
      toast(errorMessage(e), true);
    } finally {
      setAiProgress(null);
    }
  };

  const exportSubs = async (mode: 'primary' | 'dual' | 'translation') => {
    setExportOpen(false);
    const cues = ctl.state.cues;
    if (!cues.length) return;
    if (mode !== 'primary') await ctl.translateAll().catch((e) => toast(errorMessage(e), true));
    const tr = cues.map((_, i) => ctl.translationFor(i) ?? '');
    const out = mode === 'primary' ? toSrt(cues) : mode === 'dual' ? toSrt(cues, tr) : toSrt(cues.map((c, i) => ({ ...c, text: tr[i] || c.text })));
    const base = safeFilename((file?.name ?? 'subtitles').replace(/\.[^.]+$/, ''));
    downloadBlob(new Blob([out], { type: 'application/x-subrip;charset=utf-8' }), `${base}.${mode === 'translation' ? settings.nativeLang : mode === 'dual' ? 'dual' : settings.targetLang}.srt`);
  };

  return (
    <div
      class={`app${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.target === e.currentTarget) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        onFiles(Array.from(e.dataTransfer?.files ?? []));
      }}
    >
      <header class="bar">
        <Brand>
          <span class="muted"> · {t('playerTitle')}</span>
        </Brand>
        <span class="spacer" />
        <label class="btn primary">
          {t('openVideo')}
          <input type="file" accept="video/*,audio/*,.mkv" hidden onChange={(e) => onFiles(Array.from((e.target as HTMLInputElement).files ?? []))} />
        </label>
        <button class="btn" disabled={!file} onClick={async () => (await pickFile(SUBTITLE_ACCEPT).then((f) => f && loadSubtitle(f, 'primary')))}>
          {t('loadSubs')}
        </button>
        <button class="btn" disabled={!file} onClick={async () => (await pickFile(SUBTITLE_ACCEPT).then((f) => f && loadSubtitle(f, 'translation')))}>
          {t('loadTranslation')}
        </button>
        <button class="btn" disabled={!file || aiProgress !== null} onClick={transcribeFile}>
          {aiProgress !== null ? t('transcribing', aiProgress) : `✨ ${t('generateAi')}`}
        </button>
        <div class="menu-wrap">
          <button class="btn" disabled={!st.cues.length} onClick={() => setExportOpen(!exportOpen)}>
            ⬇ {t('exportSrt')}
          </button>
          {exportOpen && (
            <div class="menu card">
              <button class="btn ghost" onClick={() => exportSubs('primary')}>
                {t('primaryOnly')}
              </button>
              <button class="btn ghost" onClick={() => exportSubs('dual')}>
                {t('dual')}
              </button>
              <button class="btn ghost" onClick={() => exportSubs('translation')}>
                {t('translationOnly')}
              </button>
            </div>
          )}
        </div>
        <button class="btn" disabled={!st.cues.length} onClick={() => setDeckOpen(true)}>
          {t('exportDeck')}
        </button>
      </header>

      <main class="main">
        <section class="stage">
          <div class="video-wrap">
            {src ? (
              <video ref={videoRef} src={src} controls playsInline class="video" />
            ) : (
              <div class="drop">
                <div class="drop-icon">▶</div>
                <p>{t('dropHere')}</p>
                <div class="yt row">
                  <input class="input" placeholder={t('youtubeLink')} value={ytUrl} onInput={(e) => setYtUrl((e.target as HTMLInputElement).value)} />
                  <button class="btn" disabled={!/youtu\.?be/.test(ytUrl)} onClick={() => chrome.tabs.create({ url: ytUrl.trim() })}>
                    {t('openYoutube')}
                  </button>
                </div>
                <p class="muted small">{t('youtubeHint')}</p>
              </div>
            )}
            <div class="overlay-box" ref={overlayRef}>
              {src && <Overlay ctl={ctl} patchSettings={(p) => void patch(p)} toolbar={false} floatingTranscript={false} />}
            </div>
          </div>
          {src && (
            <div class="controls row">
              <label class="sel">
                <span>{t('subsShort')}</span>
                <select class="input" value={st.primaryId ?? ''} onChange={(e) => ctl.selectPrimary((e.target as HTMLSelectElement).value)}>
                  {!st.primaryId && <option value="">—</option>}
                  {st.tracks.map((tr) => (
                    <option value={tr.id}>{tr.label}</option>
                  ))}
                </select>
              </label>
              <label class="sel">
                <span>{t('transShort')}</span>
                <select
                  class="input"
                  value={st.translationId ?? 'off'}
                  onChange={(e) => {
                    const v = (e.target as HTMLSelectElement).value;
                    ctl.selectTranslation(v === 'off' ? null : v);
                  }}
                >
                  <option value="off">{t('off')}</option>
                  <option value="machine">{t('machineTranslation')}</option>
                  {st.tracks
                    .filter((tr) => tr.id !== st.primaryId)
                    .map((tr) => (
                      <option value={tr.id}>{tr.label}</option>
                    ))}
                </select>
              </label>
              <span class="spacer" />
              <button class="btn small" title={`${t('prevLine')} (A)`} onClick={() => ctl.prev()}>
                ⏮
              </button>
              <button class="btn small" title={`${t('repeatLine')} (S)`} onClick={() => ctl.repeat()}>
                ⟲
              </button>
              <button class="btn small" title={`${t('nextLine')} (D)`} onClick={() => ctl.next()}>
                ⏭
              </button>
              <button class={`btn small${settings.autoPause ? ' primary' : ''}`} title={`${t('autoPause')} (Q)`} onClick={() => patch({ autoPause: !settings.autoPause })}>
                ⏸ {t('autoPause')}
              </button>
              {[0.6, 0.75, 1].map((r) => (
                <button class={`btn small${st.rate === r ? ' primary' : ''}`} onClick={() => ctl.setRate(r)}>
                  {r}×
                </button>
              ))}
            </div>
          )}
          {st.message && st.status !== 'ready' && <div class="msg small muted">{st.message}</div>}
        </section>
        <aside class="side card">
          <Transcript ctl={ctl} docked />
        </aside>
      </main>

      {deckOpen && file && <DeckDialog ctl={ctl} file={file} src={src} settings={settings} onClose={() => setDeckOpen(false)} />}
    </div>
  );
}

function guessLangFromName(name: string, fallback: string): string {
  const m = name.match(/[._-]([a-z]{2}(?:-[A-Za-z]{2,4})?)\.(srt|vtt|ass|ssa|ttml|dfxp|xml)$/i);
  return m ? m[1] : fallback;
}

function DeckDialog({ ctl, file, src, settings, onClose }: { ctl: SubtitleController; file: File; src: string; settings: Settings; onClose: () => void }) {
  const [lines, setLines] = useState<'all' | 'saved'>('all');
  const [audio, setAudio] = useState(true);
  const [image, setImage] = useState(true);
  const [name, setName] = useState(`${settings.ankiDeck}::${file.name.replace(/\.[^.]+$/, '')}`);
  const [progress, setProgress] = useState<[number, number] | null>(null);

  const build = async () => {
    try {
      const cues = ctl.state.cues;
      let indices = cues.map((_, i) => i);
      if (lines === 'saved') {
        const vid = `${file.name}:${file.size}`;
        const saved = new Set((await listVocab()).filter((v) => v.kind === 'sentence' && v.source?.videoId === vid).map((v) => v.text));
        indices = indices.filter((i) => saved.has(cueToSingleLine(cues[i].text)));
      }
      if (!indices.length) throw new Error(t('noLinesYet'));
      setProgress([0, indices.length]);
      await ctl.translateAll(indices).catch(() => {});
      const RATE = 22050;
      const pcm = audio ? await decodeAudio(file, RATE).catch(() => null) : null;
      const grabber = image ? new FrameGrabber(src) : null;
      const media: ApkgMedia[] = [];
      const notes: ApkgNote[] = [];
      const stem = safeFilename(file.name.replace(/\.[^.]+$/, '')).replace(/[^\w-]+/g, '_').slice(0, 40);
      for (const [k, i] of indices.entries()) {
        const cue = cues[i];
        const base = `vidioma_${stem}_${String(i).padStart(4, '0')}`;
        const analysis = ctl.analysisFor(i);
        const fields = {
          Word: escapeHtml(cueToSingleLine(cue.text)),
          Reading: escapeHtml(analysis.roman ?? ''),
          Meaning: escapeHtml(ctl.translationFor(i) ?? ''),
          Definition: '',
          Sentence: '',
          SentenceTranslation: '',
          Source: `${escapeHtml(file.name)} · ${formatTime(cue.start)}`,
          Audio: '',
          Image: '',
          Notes: '',
        };
        if (pcm) {
          media.push({ name: `${base}.mp3`, data: encodeMp3(clip(pcm, RATE, cue.start, cue.end), RATE) });
          fields.Audio = `[sound:${base}.mp3]`;
        }
        if (grabber) {
          const jpg = await grabber.grab((cue.start + cue.end) / 2);
          if (jpg) {
            media.push({ name: `${base}.jpg`, data: jpg });
            fields.Image = `<img src="${base}.jpg">`;
          }
        }
        notes.push({ fields, tags: ['vidioma', 'sentence', settings.targetLang] });
        setProgress([k + 1, indices.length]);
      }
      grabber?.dispose();
      const bytes = await buildApkg(name.trim() || 'Vidioma', notes, media);
      downloadBlob(new Blob([bytes], { type: 'application/octet-stream' }), `${safeFilename(name.replace(/::/g, ' - '))}.apkg`);
      toast(t('deckDone', notes.length));
      onClose();
    } catch (e) {
      toast(errorMessage(e), true);
      setProgress(null);
    }
  };

  return (
    <div class="modal-back" onClick={(e) => e.target === e.currentTarget && !progress && onClose()}>
      <div class="modal card" role="dialog" aria-label={t('deckOptions')}>
        <h2>{t('deckOptions')}</h2>
        <label class="field">
          <span>{t('ankiDeck')}</span>
          <input class="input" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        <div class="field">
          <span>{t('deckLines')}</span>
          <label class="row">
            <input type="radio" checked={lines === 'all'} onChange={() => setLines('all')} /> {t('deckAllLines')} ({ctl.state.cues.length})
          </label>
          <label class="row">
            <input type="radio" checked={lines === 'saved'} onChange={() => setLines('saved')} /> {t('deckSavedLines')}
          </label>
        </div>
        <label class="row">
          <input type="checkbox" checked={audio} onChange={(e) => setAudio((e.target as HTMLInputElement).checked)} /> {t('deckAudio')}
        </label>
        <label class="row">
          <input type="checkbox" checked={image} onChange={(e) => setImage((e.target as HTMLInputElement).checked)} /> {t('deckImage')}
        </label>
        {progress && (
          <div class="progress">
            <div class="bar-fill" style={{ width: `${(progress[0] / progress[1]) * 100}%` }} />
            <span class="small">{t('deckProgress', progress[0], progress[1])}</span>
          </div>
        )}
        <div class="row end">
          <button class="btn" disabled={!!progress} onClick={onClose}>
            {t('close')}
          </button>
          <button class="btn primary" disabled={!!progress} onClick={build}>
            {t('deckBuild')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Player() {
  const [settings, patch] = useSettings();
  if (!settings) return <div class="muted" style={{ padding: 20 }}>…</div>;
  return <PlayerApp settings={settings} patch={patch} />;
}

mount(<Player />);
