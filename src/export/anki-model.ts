// The Anki note type used for exported cards, and conversion from vocabulary items.
import type { VocabItem } from '../shared/types';
import { escapeHtml, formatTime } from '../shared/util';

export const MODEL_NAME = 'Vidioma';
export const FIELDS = ['Word', 'Reading', 'Meaning', 'Definition', 'Sentence', 'SentenceTranslation', 'Source', 'Audio', 'Image', 'Notes'] as const;
export type FieldName = (typeof FIELDS)[number];

export const FRONT = `<div class="vd-front">
  <div class="word">{{Word}}</div>
  {{#Image}}<div class="img">{{Image}}</div>{{/Image}}
  {{#Sentence}}<div class="sentence">{{Sentence}}</div>{{/Sentence}}
  {{Audio}}
</div>`;

export const BACK = `{{FrontSide}}
<hr id="answer">
{{#Reading}}<div class="reading">{{Reading}}</div>{{/Reading}}
<div class="meaning">{{Meaning}}</div>
{{#Definition}}<div class="definition">{{Definition}}</div>{{/Definition}}
{{#SentenceTranslation}}<div class="st">{{SentenceTranslation}}</div>{{/SentenceTranslation}}
{{#Notes}}<div class="notes">{{Notes}}</div>{{/Notes}}
{{#Source}}<div class="source">{{Source}}</div>{{/Source}}`;

export const CSS = `.card { font-family: system-ui, "Segoe UI", Roboto, "Noto Sans", "Noto Sans CJK JP", sans-serif; font-size: 20px; text-align: center; color: #1d1d24; background: #fbfbfd; line-height: 1.45; }
.nightMode .card, .night_mode .card { color: #ececf2; background: #1b1b22; }
.word { font-size: 34px; font-weight: 700; margin: 8px 0; }
.sentence { font-size: 20px; margin: 10px auto; max-width: 640px; }
.sentence b { color: #6a5cff; }
.img img { max-width: 100%; max-height: 300px; border-radius: 8px; margin-top: 8px; }
.reading { font-size: 18px; color: #6a5cff; }
.meaning { font-size: 24px; font-weight: 600; margin: 6px 0; }
.definition, .notes { font-size: 16px; opacity: .85; margin: 6px auto; max-width: 640px; }
.st { font-size: 18px; font-style: italic; margin: 8px auto; max-width: 640px; opacity: .9; }
.source { font-size: 13px; opacity: .55; margin-top: 12px; }`;

export type NoteFields = Record<FieldName, string>;

function highlight(sentence: string, word: string): string {
  const safe = escapeHtml(sentence);
  if (!word) return safe;
  const w = escapeHtml(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return safe.replace(new RegExp(w, 'iu'), (m) => `<b>${m}</b>`);
  } catch {
    return safe;
  }
}

export function vocabToFields(v: VocabItem): NoteFields {
  const src = v.source;
  const when = src?.time != null ? ` · ${formatTime(src.time)}` : src?.location ? ` · ${escapeHtml(src.location)}` : '';
  const link = src?.url ? `<a href="${escapeHtml(src.url)}">${escapeHtml(src.title || src.url)}</a>${when}` : src?.title ? `${escapeHtml(src.title)}${when}` : '';
  return {
    Word: escapeHtml(v.text),
    Reading: escapeHtml(v.reading ?? ''),
    Meaning: escapeHtml(v.translation ?? ''),
    Definition: escapeHtml(v.definition ?? ''),
    Sentence: v.kind === 'word' && v.context ? highlight(v.context, v.text) : '',
    SentenceTranslation: escapeHtml(v.kind === 'word' ? v.contextTranslation ?? '' : ''),
    Source: link,
    Audio: '',
    Image: '',
    Notes: escapeHtml(v.notes ?? ''),
  };
}

export function vocabTags(v: VocabItem): string[] {
  return ['vidioma', v.kind, v.lang.replace(/[^\w-]/g, ''), src(v)].filter(Boolean) as string[];
}

function src(v: VocabItem): string | undefined {
  return v.source?.site ? `vidioma::${v.source.site}` : undefined;
}
