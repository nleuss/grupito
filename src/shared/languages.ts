// Language list and helpers for matching the many tag variants sites use.

export interface Language {
  code: string;
  /** Name in the language itself. */
  native: string;
  /** English name. */
  en: string;
  /** Spanish name. */
  es: string;
}

export const LANGUAGES: Language[] = [
  { code: 'en', native: 'English', en: 'English', es: 'Inglés' },
  { code: 'es', native: 'Español', en: 'Spanish', es: 'Español' },
  { code: 'fr', native: 'Français', en: 'French', es: 'Francés' },
  { code: 'de', native: 'Deutsch', en: 'German', es: 'Alemán' },
  { code: 'it', native: 'Italiano', en: 'Italian', es: 'Italiano' },
  { code: 'pt', native: 'Português', en: 'Portuguese', es: 'Portugués' },
  { code: 'ja', native: '日本語', en: 'Japanese', es: 'Japonés' },
  { code: 'ko', native: '한국어', en: 'Korean', es: 'Coreano' },
  { code: 'zh', native: '中文', en: 'Chinese', es: 'Chino' },
  { code: 'ru', native: 'Русский', en: 'Russian', es: 'Ruso' },
  { code: 'uk', native: 'Українська', en: 'Ukrainian', es: 'Ucraniano' },
  { code: 'pl', native: 'Polski', en: 'Polish', es: 'Polaco' },
  { code: 'nl', native: 'Nederlands', en: 'Dutch', es: 'Neerlandés' },
  { code: 'sv', native: 'Svenska', en: 'Swedish', es: 'Sueco' },
  { code: 'no', native: 'Norsk', en: 'Norwegian', es: 'Noruego' },
  { code: 'da', native: 'Dansk', en: 'Danish', es: 'Danés' },
  { code: 'fi', native: 'Suomi', en: 'Finnish', es: 'Finés' },
  { code: 'tr', native: 'Türkçe', en: 'Turkish', es: 'Turco' },
  { code: 'el', native: 'Ελληνικά', en: 'Greek', es: 'Griego' },
  { code: 'ar', native: 'العربية', en: 'Arabic', es: 'Árabe' },
  { code: 'he', native: 'עברית', en: 'Hebrew', es: 'Hebreo' },
  { code: 'hi', native: 'हिन्दी', en: 'Hindi', es: 'Hindi' },
  { code: 'th', native: 'ไทย', en: 'Thai', es: 'Tailandés' },
  { code: 'vi', native: 'Tiếng Việt', en: 'Vietnamese', es: 'Vietnamita' },
  { code: 'id', native: 'Bahasa Indonesia', en: 'Indonesian', es: 'Indonesio' },
  { code: 'ca', native: 'Català', en: 'Catalan', es: 'Catalán' },
  { code: 'cs', native: 'Čeština', en: 'Czech', es: 'Checo' },
  { code: 'ro', native: 'Română', en: 'Romanian', es: 'Rumano' },
  { code: 'hu', native: 'Magyar', en: 'Hungarian', es: 'Húngaro' },
];

/** "es-419" -> "es", "zh-Hans" -> "zh", "pt_BR" -> "pt", "iw" -> "he", "nb" -> "no". */
export function baseLang(tag: string | undefined | null): string {
  if (!tag) return '';
  const b = tag.toLowerCase().replace('_', '-').split('-')[0];
  return ({ iw: 'he', in: 'id', nb: 'no', nn: 'no', fil: 'tl', cmn: 'zh', yue: 'zh' } as Record<string, string>)[b] ?? b;
}

export function sameLang(a: string | undefined | null, b: string | undefined | null): boolean {
  return !!a && !!b && baseLang(a) === baseLang(b);
}

export function languageName(code: string, ui: 'en' | 'es' = 'en'): string {
  const l = LANGUAGES.find((x) => x.code === baseLang(code));
  if (!l) return code;
  return ui === 'es' ? l.es : l.en;
}

/** Languages written without spaces between words. */
export function isScriptio(lang: string): boolean {
  return ['ja', 'zh', 'th', 'lo', 'km', 'my'].includes(baseLang(lang));
}

/** Languages for which we can produce ruby readings or a romanized line. */
export function hasRomanization(lang: string): boolean {
  return ['ja', 'zh', 'ko', 'ru', 'uk', 'bg', 'sr', 'be', 'el'].includes(baseLang(lang));
}

/** Map to a Google Translate language code. */
export function googleCode(tag: string): string {
  const t = tag.toLowerCase().replace('_', '-');
  if (t.startsWith('zh')) return /hant|tw|hk|mo/.test(t) ? 'zh-TW' : 'zh-CN';
  if (t === 'he' || t === 'iw') return 'iw';
  return baseLang(t);
}

/** Map to a DeepL target language code (source codes use only the base). */
export function deeplCode(tag: string, target: boolean): string {
  const t = tag.toLowerCase().replace('_', '-');
  const b = baseLang(t).toUpperCase();
  if (!target) return b;
  if (b === 'EN') return /gb|uk/.test(t) ? 'EN-GB' : 'EN-US';
  if (b === 'PT') return /pt-pt/.test(t) ? 'PT-PT' : 'PT-BR';
  if (b === 'ZH') return /hant|tw|hk/.test(t) ? 'ZH-HANT' : 'ZH-HANS';
  return b;
}

/** Best guess of the user's language from the browser. */
export function browserLang(): string {
  try {
    const l = (typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage?.()) || navigator.language || 'en';
    return baseLang(l) || 'en';
  } catch {
    return 'en';
  }
}
