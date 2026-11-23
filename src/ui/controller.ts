// The subtitle controller: owns tracks, cues, translations and playback helpers.
// Shared by the content script (streaming sites) and the local player page.
import type { Cue, ExplainResult, LineAnalysis, LookupResult, Settings, SttSegment, TrackInfo, VideoInfo } from '../shared/types';
import { Store } from '../shared/store';
import { activeCueIndices, alignCues, lastStartedIndex, normalizeCues } from '../subtitles/cues';
import { cueToSingleLine } from '../subtitles/text';
import { baseLang, languageName, sameLang } from '../shared/languages';
import { chunkBy, errorMessage } from '../shared/util';
import { addVocab, normalizeWord, savedWordSet } from '../shared/vocab';
import { analyzeLocal } from '../text/tokenize';
import { parseSubtitles } from '../subtitles/parsers';
import type { Services } from './services';
import { TimeMap } from './timemap';
import { speak } from './speech';
import { t, uiLang } from './i18n';

export interface PlayerHost {
  getVideo(): HTMLVideoElement | null;
  seek(time: number): void;
  /** Seconds to add to video.currentTime to reach the subtitle timeline. */
  timeOffset(): number;
  videoInfo(): VideoInfo | null;
  loadTrack(track: TrackInfo): Promise<Cue[]>;
  loadSiteTranslation?(track: TrackInfo, lang: string): Promise<Cue[] | null>;
}

export interface PopupState {
  cueIndex: number;
  tokenIndex: number;
  word: string;
  lemma?: string;
  reading?: string;
  sentence: string;
  /** Anchor point (px) relative to the overlay root. */
  x: number;
  y: number;
  loading: boolean;
  lookup?: LookupResult;
  error?: string;
  explaining?: boolean;
  explain?: ExplainResult;
  explainError?: string;
  saved?: boolean;
  wasPlaying: boolean;
}

export type TranslationSource = string | 'machine' | 'site' | null;

export interface ControllerState {
  settings: Settings;
  tracks: TrackInfo[];
  primaryId: string | null;
  translationId: TranslationSource;
  cues: Cue[];
  /** Bumped whenever translations or analyses change. */
  version: number;
  active: number[];
  /** Index of the last cue that has started (for navigation and the transcript). */
  current: number;
  status: 'idle' | 'loading' | 'ready' | 'empty' | 'error';
  message: string;
  popup: PopupState | null;
  transcriptOpen: boolean;
  syncOffset: number;
  saved: Set<string>;
  toast: { text: string; error?: boolean; id: number } | null;
  aiActive: boolean;
  hidden: boolean;
  revealTranslation: boolean;
  ai: { claude: boolean; deepl: boolean; stt: boolean };
  /** Toolbar visibility (shown while the mouse moves over the video). */
  controlsVisible: boolean;
  rate: number;
}

const KIND_RANK: Record<string, number> = { subtitles: 0, file: 1, captions: 2, ai: 3, asr: 4, forced: 9 };

export function bestTrack(tracks: TrackInfo[], lang: string, exclude?: string | null): TrackInfo | undefined {
  return tracks
    .filter((t) => t.id !== exclude && t.kind !== 'forced' && sameLang(t.lang, lang))
    .sort((a, b) => (KIND_RANK[a.kind] ?? 5) - (KIND_RANK[b.kind] ?? 5) || Number(b.lang === lang) - Number(a.lang === lang))[0];
}

export class SubtitleController {
  readonly store: Store<ControllerState>;
  private gen = 0;
  private aligned: string[] | null = null;
  private machine = new Map<string, string>();
  private analyses = new Map<string, LineAnalysis>();
  private translating = false;
  private translateFailures = 0;
  private translateBlockedUntil = 0;
  private analyzing = false;
  private armed = -1;
  private lastArmedFor = -1;
  private raf = 0;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private hoverPaused = false;
  private aiCues: Cue[] = [];
  readonly timeMap = new TimeMap();
  private videoEl: HTMLVideoElement | null = null;

  constructor(
    private host: PlayerHost,
    private services: Services,
    settings: Settings,
  ) {
    this.store = new Store<ControllerState>({
      settings,
      tracks: [],
      primaryId: null,
      translationId: null,
      cues: [],
      version: 0,
      active: [],
      current: -1,
      status: 'idle',
      message: '',
      popup: null,
      transcriptOpen: false,
      syncOffset: 0,
      saved: new Set(),
      toast: null,
      aiActive: false,
      hidden: false,
      revealTranslation: false,
      ai: { claude: false, deepl: false, stt: false },
      controlsVisible: false,
      rate: 1,
    });
    this.refreshSaved();
    services
      .aiStatus()
      .then((ai) => this.store.set({ ai }))
      .catch(() => {});
  }

  get state() {
    return this.store.get();
  }

  // ------------------------------------------------------------------ lifecycle

  start() {
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.tick();
    };
    if (!this.raf) this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.timeMap.detach();
  }

  /** Forget everything about the previous video. */
  reset() {
    this.gen++;
    this.aligned = null;
    this.machine.clear();
    this.analyses.clear();
    this.aiCues = [];
    this.armed = this.lastArmedFor = -1;
    this.store.set({ tracks: [], primaryId: null, translationId: null, cues: [], active: [], current: -1, status: 'idle', message: '', popup: null, syncOffset: 0, version: this.state.version + 1 });
  }

  updateSettings(settings: Settings) {
    const prev = this.state.settings;
    this.store.set({ settings });
    if (!sameLang(prev.targetLang, settings.targetLang) || !sameLang(prev.nativeLang, settings.nativeLang)) {
      this.machine.clear();
      this.autoSelect();
    } else if (prev.translationProvider !== settings.translationProvider) {
      this.machine.clear();
      this.bump();
      this.pumpTranslations();
    }
  }

  async refreshSaved() {
    try {
      this.store.set({ saved: await savedWordSet(this.state.settings.targetLang) });
    } catch {
      /* storage unavailable */
    }
  }

  // ------------------------------------------------------------------ tracks

  setTracks(tracks: TrackInfo[]) {
    const keep = this.state.tracks.filter((t) => (t.kind === 'file' || t.kind === 'ai') && !tracks.some((n) => n.id === t.id));
    const merged = [...tracks, ...keep];
    const same = merged.length === this.state.tracks.length && merged.every((t, i) => t.id === this.state.tracks[i]?.id);
    if (!same) this.store.set({ tracks: merged });
    if (!this.state.primaryId || !merged.some((t) => t.id === this.state.primaryId)) this.autoSelect();
  }

  primaryTrack(): TrackInfo | undefined {
    return this.state.tracks.find((t) => t.id === this.state.primaryId);
  }

  private autoSelect() {
    const { tracks, settings } = this.state;
    const primary = bestTrack(tracks, settings.targetLang);
    if (!primary) {
      if (tracks.length)
        this.store.set({ status: 'empty', message: t('noTargetTrack', languageName(settings.targetLang, uiLang())) });
      return;
    }
    this.selectPrimary(primary.id, false);
  }

  private defaultTranslation(primary: TrackInfo): TranslationSource {
    const s = this.state.settings;
    if (sameLang(primary.lang, s.nativeLang)) return null;
    if (s.preferOfficialTranslation) {
      const official = bestTrack(this.state.tracks, s.nativeLang, primary.id);
      if (official) return official.id;
      if (primary.siteTranslatable && this.host.loadSiteTranslation) return 'site';
    }
    return 'machine';
  }

  async selectPrimary(id: string, keepTranslation = true) {
    const track = this.state.tracks.find((t) => t.id === id);
    if (!track) return;
    const gen = ++this.gen;
    const prevLang = this.primaryTrack()?.lang;
    if (!sameLang(prevLang, track.lang)) this.machine.clear();
    this.aligned = null;
    this.analyses.clear();
    this.armed = this.lastArmedFor = -1;
    this.store.set({ primaryId: id, status: 'loading', message: '', cues: [], active: [], current: -1, popup: null });
    try {
      const raw = track.kind === 'ai' ? this.aiCues : await this.host.loadTrack(track);
      if (gen !== this.gen) return;
      const cues = normalizeCues(raw, { trimOverlaps: track.kind === 'asr' || track.kind === 'ai' });
      this.store.set({ cues, status: cues.length ? 'ready' : 'empty', message: cues.length ? '' : t('emptyTrack'), version: this.state.version + 1 });
      const cur = this.state.translationId;
      const valid = cur === 'machine' || (cur === 'site' && track.siteTranslatable) || (cur && cur !== id && this.state.tracks.some((t) => t.id === cur));
      await this.selectTranslation(keepTranslation && valid ? cur : this.defaultTranslation(track));
      this.pumpAnalyses();
    } catch (e) {
      if (gen === this.gen) this.store.set({ status: 'error', message: t('loadFailed', errorMessage(e)) });
    }
  }

  async selectTranslation(id: TranslationSource) {
    const gen = this.gen;
    this.aligned = null;
    this.store.set({ translationId: id, version: this.state.version + 1 });
    if (!id) return;
    if (id === 'machine') {
      this.pumpTranslations();
      return;
    }
    try {
      const primary = this.primaryTrack();
      let secondary: Cue[] | null = null;
      if (id === 'site') {
        if (primary && this.host.loadSiteTranslation) secondary = await this.host.loadSiteTranslation(primary, this.state.settings.nativeLang);
      } else {
        const track = this.state.tracks.find((t) => t.id === id);
        if (track) secondary = await this.host.loadTrack(track);
      }
      if (gen !== this.gen) return;
      if (!secondary?.length) throw new Error(t('emptyTrack'));
      this.alignTo(normalizeCues(secondary));
    } catch (e) {
      if (gen !== this.gen) return;
      this.showToast(t('translationTrackFailed', errorMessage(e)), true);
      this.store.set({ translationId: 'machine' });
      this.pumpTranslations();
    }
  }

  private secondaryCues: Cue[] | null = null;
  private alignTo(secondary: Cue[]) {
    this.secondaryCues = secondary;
    this.aligned = alignCues(this.state.cues, secondary);
    this.bump();
  }

  /** Add a subtitle file chosen by the user as a new track (and select it). */
  addFileTrack(name: string, text: string, as: 'primary' | 'translation', lang?: string): TrackInfo {
    const cues = parseSubtitles(text);
    if (!cues.length) throw new Error(t('emptyTrack'));
    const s = this.state.settings;
    const track: TrackInfo = {
      id: `file:${name}:${Date.now()}`,
      lang: lang ?? (as === 'primary' ? s.targetLang : s.nativeLang),
      label: name,
      kind: 'file',
      data: { cues },
    };
    this.store.set({ tracks: [...this.state.tracks, track] });
    if (as === 'primary' || !this.state.primaryId) this.selectPrimary(track.id);
    else this.selectTranslation(track.id);
    return track;
  }

  // ------------------------------------------------------------------ text for a cue

  translationFor(i: number): string | undefined {
    const st = this.state;
    if (!st.translationId || i < 0 || i >= st.cues.length) return undefined;
    if (this.aligned) return this.aligned[i];
    if (st.translationId === 'machine') return this.machine.get(cueToSingleLine(st.cues[i].text));
    return undefined;
  }

  analysisFor(i: number): LineAnalysis {
    const cue = this.state.cues[i];
    if (!cue) return { tokens: [] };
    const cached = this.analyses.get(cue.text);
    if (cached) return cached;
    const lang = this.primaryTrack()?.lang ?? this.state.settings.targetLang;
    const local = analyzeLocal(cue.text, lang);
    const b = baseLang(lang);
    // ja/zh get a richer async analysis; cache local results for everything else.
    if (b !== 'ja' && b !== 'zh') this.analyses.set(cue.text, local);
    return local;
  }

  isSaved(word: string, lemma?: string): boolean {
    const s = this.state.saved;
    return s.has(normalizeWord(word)) || (!!lemma && s.has(normalizeWord(lemma)));
  }

  private bump() {
    this.store.set({ version: this.state.version + 1 });
  }

  // ------------------------------------------------------------------ background work queues

  pumpTranslations() {
    const st = this.state;
    if (this.translating || st.translationId !== 'machine' || !st.cues.length) return;
    const from = this.primaryTrack()?.lang ?? st.settings.targetLang;
    const to = st.settings.nativeLang;
    if (sameLang(from, to)) return;
    const wait = this.translateBlockedUntil - Date.now();
    if (wait > 0) {
      setTimeout(() => this.pumpTranslations(), wait + 50);
      return;
    }
    const cues = st.cues;
    const cur = Math.max(0, st.current);
    const want = new Set<string>();
    for (let i = Math.max(0, cur - 3); i < Math.min(cues.length, cur + 40); i++) {
      const s = cueToSingleLine(cues[i].text);
      if (!this.machine.has(s)) want.add(s);
    }
    const background = want.size === 0;
    if (background) {
      for (let i = 0; i < cues.length && want.size < 60; i++) {
        const s = cueToSingleLine(cues[i].text);
        if (!this.machine.has(s)) want.add(s);
      }
    }
    if (!want.size) return;
    const batch = chunkBy([...want], 50, 4000, (s) => s.length)[0];
    const gen = this.gen;
    this.translating = true;
    this.services
      .translate(batch, from, to, st.settings, this.host.videoInfo()?.title)
      .then((res) => {
        if (gen !== this.gen) return;
        batch.forEach((s, k) => this.machine.set(s, res[k] ?? ''));
        this.translateFailures = 0;
        this.bump();
      })
      .catch((e) => {
        if (gen !== this.gen) return;
        this.translateFailures++;
        this.translateBlockedUntil = Date.now() + Math.min(60000, 2000 * 2 ** this.translateFailures);
        if (this.translateFailures <= 2) this.showToast(t('translateFailed', errorMessage(e)), true);
      })
      .finally(() => {
        this.translating = false;
        setTimeout(() => this.pumpTranslations(), background ? 1200 : 30);
      });
  }

  /** Make sure machine translations exist for the given cues (e.g. before exporting). */
  async translateAll(indices?: number[]) {
    const st = this.state;
    if (st.translationId !== 'machine') return;
    const from = this.primaryTrack()?.lang ?? st.settings.targetLang;
    const to = st.settings.nativeLang;
    if (sameLang(from, to)) return;
    const idx = indices ?? st.cues.map((_, i) => i);
    const missing = [...new Set(idx.map((i) => cueToSingleLine(st.cues[i].text)).filter((s) => !this.machine.has(s)))];
    for (const batch of chunkBy(missing, 50, 4000, (s) => s.length)) {
      const res = await this.services.translate(batch, from, to, st.settings, this.host.videoInfo()?.title);
      batch.forEach((s, k) => this.machine.set(s, res[k] ?? ''));
    }
    this.bump();
  }

  pumpAnalyses() {
    const st = this.state;
    const lang = this.primaryTrack()?.lang ?? st.settings.targetLang;
    const b = baseLang(lang);
    if (this.analyzing || (b !== 'ja' && b !== 'zh') || !st.cues.length) return;
    const cur = Math.max(0, st.current);
    const order = [...Array(st.cues.length).keys()].sort((a, b2) => Math.abs(a - cur) - Math.abs(b2 - cur));
    const lines: string[] = [];
    for (const i of order) {
      const text = st.cues[i].text;
      if (!this.analyses.has(text) && !lines.includes(text)) lines.push(text);
      if (lines.length >= 80) break;
    }
    if (!lines.length) return;
    const gen = this.gen;
    this.analyzing = true;
    this.services
      .analyze(lines, lang)
      .then((res) => {
        if (gen !== this.gen) return;
        lines.forEach((l, k) => res[k] && this.analyses.set(l, res[k]));
        this.bump();
      })
      .catch(() => {
        // Keep local segmentation for these lines so we don't retry forever.
        lines.forEach((l) => this.analyses.set(l, analyzeLocal(l, lang)));
      })
      .finally(() => {
        this.analyzing = false;
        setTimeout(() => this.pumpAnalyses(), 50);
      });
  }

  // ------------------------------------------------------------------ playback

  private video(): HTMLVideoElement | null {
    const v = this.host.getVideo();
    if (v !== this.videoEl) {
      this.videoEl = v;
      this.timeMap.attach(v);
    }
    return v;
  }

  subtitleTime(): number {
    const v = this.video();
    return v ? v.currentTime + this.host.timeOffset() + this.state.syncOffset : 0;
  }

  tick() {
    const v = this.video();
    const st = this.state;
    if (!v || !st.cues.length) return;
    const time = v.currentTime + this.host.timeOffset() + st.syncOffset;
    const active = activeCueIndices(st.cues, time);
    const current = lastStartedIndex(st.cues, time);

    if (st.settings.autoPause && !v.paused && this.armed >= 0) {
      const c = st.cues[this.armed];
      if (c && time >= c.end - 0.12 && time < c.end + 0.6) {
        v.pause();
        this.armed = -1;
      }
    }
    if (!v.paused && active.length) {
      const last = active[active.length - 1];
      if (last !== this.lastArmedFor) {
        this.lastArmedFor = last;
        this.armed = last;
      }
    }
    if (current !== st.current || active.length !== st.active.length || active.some((x, i) => x !== st.active[i])) {
      this.store.set({ active, current });
      this.pumpTranslations();
      this.pumpAnalyses();
    }
  }

  private toVideoTime(subTime: number) {
    return subTime - this.host.timeOffset() - this.state.syncOffset;
  }

  seekToCue(i: number, play = true) {
    const cue = this.state.cues[i];
    const v = this.video();
    if (!cue || !v) return;
    this.host.seek(this.toVideoTime(cue.start) + 0.02);
    this.armed = i;
    this.lastArmedFor = i;
    if (play && v.paused) v.play().catch(() => {});
  }

  prev() {
    const st = this.state;
    // Inside a line: go to the one before. In a gap: go to the line that just ended.
    const i = st.active.length ? st.active[0] - 1 : lastStartedIndex(st.cues, this.subtitleTime());
    this.seekToCue(Math.max(0, i));
  }

  repeat() {
    const st = this.state;
    const i = st.active.length ? st.active[0] : lastStartedIndex(st.cues, this.subtitleTime());
    if (i >= 0) this.seekToCue(i);
  }

  next() {
    const st = this.state;
    const time = this.subtitleTime();
    const i = st.active.length ? st.active[st.active.length - 1] + 1 : lastStartedIndex(st.cues, time) + 1;
    if (i < st.cues.length) this.seekToCue(i);
  }

  togglePlay() {
    const v = this.video();
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }

  setRate(rate: number) {
    const v = this.video();
    if (v) v.playbackRate = rate;
    this.store.set({ rate });
  }

  nudgeSync(delta: number) {
    const syncOffset = Math.round((this.state.syncOffset + delta) * 100) / 100;
    this.store.set({ syncOffset });
    this.showToast(t('syncOffset', (syncOffset > 0 ? '+' : '') + syncOffset.toFixed(2)));
  }

  hoverStart() {
    const v = this.video();
    if (this.state.settings.pauseOnHover && v && !v.paused) {
      v.pause();
      this.hoverPaused = true;
    }
  }

  hoverEnd() {
    const v = this.video();
    if (this.hoverPaused && v && v.paused && !this.state.popup) v.play().catch(() => {});
    this.hoverPaused = false;
  }

  // ------------------------------------------------------------------ word popup

  async openWord(cueIndex: number, tokenIndex: number, x: number, y: number) {
    const st = this.state;
    const analysis = this.analysisFor(cueIndex);
    const token = analysis.tokens[tokenIndex];
    if (!token) return;
    const v = this.video();
    const wasPlaying = st.popup?.wasPlaying ?? (!!v && !v.paused);
    if (st.settings.pauseOnWordClick && v && !v.paused) v.pause();
    const sentence = cueToSingleLine(st.cues[cueIndex].text);
    const popup: PopupState = {
      cueIndex,
      tokenIndex,
      word: token.text,
      lemma: token.lemma && token.lemma !== token.text ? token.lemma : undefined,
      reading: token.reading,
      sentence,
      x,
      y,
      loading: true,
      wasPlaying: wasPlaying || this.hoverPaused,
      saved: this.isSaved(token.text, token.lemma),
    };
    this.hoverPaused = false;
    this.store.set({ popup });
    const from = this.primaryTrack()?.lang ?? st.settings.targetLang;
    try {
      const lookup = await this.services.lookup(token.text, token.lemma, sentence, from, st.settings.nativeLang);
      if (this.state.popup?.word === token.text && this.state.popup.cueIndex === cueIndex) this.patchPopup({ loading: false, lookup });
    } catch (e) {
      if (this.state.popup?.word === token.text) this.patchPopup({ loading: false, error: errorMessage(e) });
    }
  }

  private patchPopup(p: Partial<PopupState>) {
    const cur = this.state.popup;
    if (cur) this.store.set({ popup: { ...cur, ...p } });
  }

  closePopup() {
    const p = this.state.popup;
    if (!p) return;
    this.store.set({ popup: null });
    const v = this.video();
    if (p.wasPlaying && this.state.settings.resumeAfterPopup && v?.paused) v.play().catch(() => {});
  }

  async explainWord() {
    const p = this.state.popup;
    if (!p || p.explaining) return;
    this.patchPopup({ explaining: true, explainError: undefined });
    const from = this.primaryTrack()?.lang ?? this.state.settings.targetLang;
    try {
      const explain = await this.services.explain(p.word, p.sentence, from, this.state.settings.nativeLang);
      if (this.state.popup?.word === p.word) this.patchPopup({ explaining: false, explain });
    } catch (e) {
      if (this.state.popup?.word === p.word) this.patchPopup({ explaining: false, explainError: errorMessage(e) });
    }
  }

  speakText(text: string) {
    const lang = this.primaryTrack()?.lang ?? this.state.settings.targetLang;
    speak(text, lang);
  }

  private source(cueIndex?: number) {
    const info = this.host.videoInfo();
    const cue = cueIndex != null ? this.state.cues[cueIndex] : undefined;
    return info ? { site: info.site, title: info.title, url: info.url, videoId: info.id, time: cue ? this.toVideoTime(cue.start) : undefined } : undefined;
  }

  async saveWord() {
    const p = this.state.popup;
    if (!p) return;
    const lang = this.primaryTrack()?.lang ?? this.state.settings.targetLang;
    const lk = p.lookup;
    const ex = p.explain;
    const definition = ex?.meaning || lk?.definitions.slice(0, 2).map((d) => d.text).join('; ') || undefined;
    const translation = lk?.translation || ex?.meaning?.split(/[.;]/)[0] || lk?.entries[0]?.terms[0];
    await addVocab({
      kind: 'word',
      lang,
      text: p.word,
      lemma: p.lemma ?? (ex?.lemma && ex.lemma !== p.word ? ex.lemma : undefined),
      reading: p.reading ?? (ex?.reading || lk?.romanization || undefined),
      translation,
      definition,
      context: p.sentence,
      contextTranslation: this.translationFor(p.cueIndex) ?? ex?.sentenceTranslation,
      source: this.source(p.cueIndex),
    });
    this.patchPopup({ saved: true });
    this.showToast(t('toastSaved'));
    this.refreshSaved();
  }

  async saveSentence(cueIndex: number) {
    const cue = this.state.cues[cueIndex];
    if (!cue) return;
    await addVocab({
      kind: 'sentence',
      lang: this.primaryTrack()?.lang ?? this.state.settings.targetLang,
      text: cueToSingleLine(cue.text),
      translation: this.translationFor(cueIndex),
      source: this.source(cueIndex),
    });
    this.showToast(t('toastSentenceSaved'));
  }

  // ------------------------------------------------------------------ AI captions

  setAiActive(active: boolean, error?: string) {
    this.store.set({ aiActive: active });
    if (error) this.showToast(error, true);
    if (active && !this.state.tracks.some((t) => t.id === 'ai')) {
      const track: TrackInfo = { id: 'ai', lang: this.state.settings.targetLang, label: t('aiTrackLabel'), kind: 'ai' };
      this.store.set({ tracks: [...this.state.tracks, track] });
      this.selectPrimary('ai');
    }
  }

  /** Segments from speech-to-text, timestamped relative to a wall-clock chunk start. */
  addAiSegments(wallStart: number, segments: SttSegment[]) {
    const offset = this.host.timeOffset();
    const added: Cue[] = [];
    for (const s of segments) {
      const a = this.timeMap.toMedia(wallStart + s.start * 1000);
      const b = this.timeMap.toMedia(wallStart + s.end * 1000);
      if (a == null || b == null || !s.text.trim()) continue;
      added.push({ start: a + offset, end: Math.max(b + offset, a + offset + 0.5), text: s.text.trim() });
    }
    this.addAiCues(added);
  }

  /** Cues already on the subtitle timeline (local files). */
  addAiCues(cues: Cue[]) {
    if (!cues.length) return;
    this.aiCues = normalizeCues([...this.aiCues, ...cues], { trimOverlaps: true });
    if (!this.state.tracks.some((t) => t.id === 'ai')) {
      this.store.set({ tracks: [...this.state.tracks, { id: 'ai', lang: this.state.settings.targetLang, label: t('aiTrackLabel'), kind: 'ai' }] });
    }
    if (this.state.primaryId === 'ai') {
      this.store.set({ cues: this.aiCues, status: 'ready', message: '' });
      if (this.secondaryCues && this.aligned) this.aligned = alignCues(this.aiCues, this.secondaryCues);
      this.bump();
      this.pumpTranslations();
      this.pumpAnalyses();
    } else if (!this.state.primaryId || this.state.status !== 'ready') {
      this.selectPrimary('ai');
    }
  }

  getAiCues(): Cue[] {
    return this.aiCues;
  }

  // ------------------------------------------------------------------ misc UI state

  toggleTranscript(open?: boolean) {
    this.store.set({ transcriptOpen: open ?? !this.state.transcriptOpen });
  }

  private controlsTimer: ReturnType<typeof setTimeout> | undefined;
  showControls() {
    clearTimeout(this.controlsTimer);
    this.store.set({ controlsVisible: true });
    this.controlsTimer = setTimeout(() => this.store.set({ controlsVisible: false }), 2800);
  }

  toggleHidden() {
    this.store.set({ hidden: !this.state.hidden });
  }

  showToast(text: string, error = false) {
    clearTimeout(this.toastTimer);
    this.store.set({ toast: { text, error, id: Date.now() } });
    this.toastTimer = setTimeout(() => this.store.set({ toast: null }), error ? 6000 : 2200);
  }

  /** Keyboard shortcuts shared by every surface. Returns true when handled. */
  handleKey(e: KeyboardEvent, patchSettings: (p: Partial<Settings>) => void): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const target = e.composedPath()[0] as HTMLElement | undefined;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return false;
    const s = this.state.settings;
    switch (e.key.toLowerCase()) {
      case 'a':
        this.prev();
        return true;
      case 's':
        this.repeat();
        return true;
      case 'd':
        this.next();
        return true;
      case 'q':
        patchSettings({ autoPause: !s.autoPause });
        this.showToast(t(!s.autoPause ? 'autoPauseOn' : 'autoPauseOff'));
        return true;
      case 'w':
        patchSettings({ showTranslation: !s.showTranslation });
        return true;
      case 'e':
        this.store.set({ revealTranslation: !this.state.revealTranslation });
        return true;
      case 'r':
        patchSettings({ romanizationLine: !s.romanizationLine });
        return true;
      case 'g':
        this.toggleTranscript();
        return true;
      case '[':
        this.nudgeSync(-0.25);
        return true;
      case ']':
        this.nudgeSync(0.25);
        return true;
      case 'escape':
        if (this.state.popup) {
          this.closePopup();
          return true;
        }
        return false;
      default:
        return false;
    }
  }
}
