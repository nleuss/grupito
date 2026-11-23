// Chinese: word segmentation (Intl.Segmenter) + context-aware pinyin (pinyin-pro).
import { pinyin } from 'pinyin-pro';
import type { LineAnalysis, Token } from '../shared/types';
import { tokenize } from './tokenize';

export function analyzeChinese(line: string): LineAnalysis {
  // Pinyin for the whole line resolves polyphones (e.g. 行长 → háng zhǎng) using context.
  const perChar = pinyin(line, { type: 'all' }) as { origin: string; pinyin: string; isZh: boolean }[];
  const chars = perChar.map((c) => c.origin);
  let ci = 0;
  const tokens: Token[] = tokenize(line, 'zh').map((tk) => {
    const len = Array.from(tk.text).length;
    const items = perChar.slice(ci, ci + len);
    // Guard against any misalignment between the two segmentations.
    if (items.map((i) => i.origin).join('') !== tk.text) {
      const found = chars.join('').indexOf(tk.text, chars.slice(0, ci).join('').length);
      if (found >= 0) ci = Array.from(chars.join('').slice(0, found)).length;
    }
    const slice = perChar.slice(ci, ci + len);
    ci += len;
    const zh = slice.filter((s) => s.isZh && s.pinyin);
    if (!tk.word || !zh.length) return tk;
    return {
      ...tk,
      reading: zh.map((s) => s.pinyin).join(' '),
      ruby: slice.map((s) => (s.isZh && s.pinyin ? { base: s.origin, rt: s.pinyin } : { base: s.origin })),
      roman: zh.map((s) => s.pinyin).join(''),
    };
  });
  const roman = tokens
    .map((t) => (t.roman ? t.roman : t.word ? t.text : t.text.trim()))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+([,.!?;:，。！？；：])/g, '$1');
  return { tokens, roman };
}
