// Core data types shared by every part of the extension.

export type SiteId = 'netflix' | 'youtube' | 'generic' | 'local' | 'book';
export type StreamingSite = 'netflix' | 'youtube';
export const STREAMING_SITES: StreamingSite[] = ['youtube', 'netflix'];

/** One subtitle cue. Times are in seconds on the video's own timeline. */
export interface Cue {
  start: number;
  end: number;
  /** Plain text; multiple display lines are separated by "\n". */
  text: string;
}

export type TrackKind = 'subtitles' | 'captions' | 'asr' | 'forced' | 'ai' | 'file';

export interface TrackInfo {
  /** Unique within the current video. */
  id: string;
  /** Language tag as reported by the site (e.g. "en", "es-419", "zh-Hans"). */
  lang: string;
  label: string;
  kind: TrackKind;
  /** Adapter-specific locator (URLs, playlist, raw cues…). */
  data?: unknown;
  /** The site itself can machine-translate this track (YouTube "tlang"). */
  siteTranslatable?: boolean;
}

export interface VideoInfo {
  site: SiteId;
  id: string;
  title: string;
  url: string;
}

export interface RubyPart {
  base: string;
  rt?: string;
}

export interface Token {
  /** Surface text exactly as it appears in the line. */
  text: string;
  /** Clickable word (false for spaces and punctuation). */
  word: boolean;
  /** Dictionary form, when known (Japanese via morphological analysis). */
  lemma?: string;
  /** Reading in kana (ja) or pinyin (zh). */
  reading?: string;
  /** Ruby segments for furigana / pinyin rendering. */
  ruby?: RubyPart[];
  /** Romanization of this token. */
  roman?: string;
}

export interface LineAnalysis {
  tokens: Token[];
  /** Romanized version of the whole line (romaji, pinyin, RR…). */
  roman?: string;
}

export interface DictEntry {
  pos: string;
  terms: string[];
}

export interface Definition {
  pos?: string;
  text: string;
  example?: string;
}

export interface LookupResult {
  word: string;
  lemma?: string;
  /** Best single translation of the word. */
  translation?: string;
  /** Bilingual dictionary entries grouped by part of speech. */
  entries: DictEntry[];
  /** Monolingual definitions (usually in the source language or English). */
  definitions: Definition[];
  romanization?: string;
  sources: string[];
}

export interface ExplainResult {
  lemma: string;
  reading: string;
  partOfSpeech: string;
  /** Meaning of the word in this specific sentence, in the learner's language. */
  meaning: string;
  /** Grammar notes: conjugation, tense, particles, agreement… */
  grammar: string;
  otherMeanings: string[];
  examples: { text: string; translation: string }[];
  /** Natural translation of the full sentence. */
  sentenceTranslation: string;
}

export type VocabStatus = 'new' | 'learning' | 'known';

export interface VocabSource {
  site: SiteId;
  title: string;
  url: string;
  videoId?: string;
  /** Position in the video, seconds. */
  time?: number;
  /** Position in a book (chapter · paragraph). */
  location?: string;
}

export interface VocabItem {
  id: string;
  kind: 'word' | 'sentence';
  /** Language of `text` (the language being learned). */
  lang: string;
  text: string;
  lemma?: string;
  reading?: string;
  translation?: string;
  definition?: string;
  /** Sentence in which the word appeared. */
  context?: string;
  contextTranslation?: string;
  source?: VocabSource;
  status: VocabStatus;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export type TranslationProvider = 'auto' | 'chrome' | 'google' | 'deepl' | 'claude' | 'mock';

export interface Settings {
  enabled: boolean;
  sites: Record<StreamingSite, boolean>;
  /** Language being learned. */
  targetLang: string;
  /** Learner's own language (translations are shown in it). */
  nativeLang: string;
  uiLang: 'auto' | 'en' | 'es';

  // Display
  showPrimary: boolean;
  showTranslation: boolean;
  translationOnTop: boolean;
  blurTranslation: boolean;
  rubyReadings: boolean;
  romanizationLine: boolean;
  highlightSaved: boolean;
  fontScale: number;
  translationScale: number;
  bottomOffset: number;
  bgOpacity: number;
  primaryColor: string;
  translationColor: string;
  fontFamily: string;

  // Behaviour
  hideNativeSubs: boolean;
  autoPause: boolean;
  pauseOnHover: boolean;
  pauseOnWordClick: boolean;
  resumeAfterPopup: boolean;
  preferOfficialTranslation: boolean;

  // Providers
  translationProvider: TranslationProvider;
  claudeModel: string;
  sttBaseUrl: string;
  sttModel: string;
  ankiDeck: string;
}

/** Secrets live in chrome.storage.local only (never synced). */
export interface Secrets {
  claudeKey: string;
  deeplKey: string;
  sttKey: string;
}

/** A segment returned by speech-to-text, relative to the start of its audio chunk. */
export interface SttSegment {
  start: number;
  end: number;
  text: string;
}
