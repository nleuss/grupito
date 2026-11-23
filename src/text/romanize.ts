// Offline transliteration for Korean (Revised Romanization, simplified), Cyrillic and Greek.
// Japanese and Chinese are handled in the offscreen document (kuromoji / pinyin-pro).
import { baseLang } from '../shared/languages';

const INITIALS = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const MEDIALS = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
const FINALS = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'l', 'l', 'l', 'p', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't'];
// Sound a final consonant takes when the next syllable starts with the silent ㅇ (liaison).
const LIAISON: Record<number, string> = {
  1: 'g', 2: 'kk', 4: 'n', 7: 'd', 8: 'r', 16: 'm', 17: 'b', 19: 's', 20: 'ss', 22: 'j', 23: 'ch', 24: 'k', 25: 't', 26: 'p', 27: '',
};

export function romanizeKorean(text: string): string {
  const chars = Array.from(text);
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const code = chars[i].codePointAt(0)! - 0xac00;
    if (code < 0 || code > 11171) {
      out += chars[i];
      continue;
    }
    const ini = Math.floor(code / 588);
    const med = Math.floor((code % 588) / 28);
    const fin = code % 28;
    let initial = INITIALS[ini];
    // Liaison: previous final already emitted as this syllable's initial.
    if (ini === 11 && i > 0) {
      const prev = chars[i - 1].codePointAt(0)! - 0xac00;
      if (prev >= 0 && prev <= 11171 && LIAISON[prev % 28] !== undefined) initial = LIAISON[prev % 28];
    }
    let final = FINALS[fin];
    const next = chars[i + 1]?.codePointAt(0);
    if (fin && next !== undefined) {
      const n = next - 0xac00;
      if (n >= 0 && n <= 11171 && Math.floor(n / 588) === 11 && LIAISON[fin] !== undefined) final = '';
    }
    out += initial + MEDIALS[med] + final;
  }
  return out;
}

const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'w', ђ: 'đ', ј: 'j', љ: 'lj',
  њ: 'nj', ћ: 'ć', џ: 'dž',
};

const GREEK: Record<string, string> = {
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm', ν: 'n', ξ: 'x',
  ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't', υ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o',
};

function mapChars(text: string, table: Record<string, string>, stripAccents = false): string {
  let out = '';
  for (const ch of text) {
    const base = stripAccents ? ch.normalize('NFD').replace(/\p{M}/gu, '') : ch;
    const lower = base.toLowerCase();
    const m = table[lower];
    if (m === undefined) out += ch;
    else out += base !== lower && m ? m[0].toUpperCase() + m.slice(1) : m;
  }
  return out;
}

/** Romanized line, or undefined when the language has no offline transliteration. */
export function romanizeLine(text: string, lang: string): string | undefined {
  switch (baseLang(lang)) {
    case 'ko':
      return romanizeKorean(text);
    case 'ru':
    case 'uk':
    case 'bg':
    case 'sr':
    case 'be':
    case 'mk':
      return mapChars(text, CYRILLIC);
    case 'el':
      return mapChars(text, GREEK, true);
    default:
      return undefined;
  }
}
