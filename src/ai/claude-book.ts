// Claude with book context: a one-time "digest" of the whole book (Claude reads it entirely)
// and word explanations that use that digest plus the surrounding passage.
// Runs in the reader page (no service-worker time limits for long requests).
import type { ExplainResult } from '../shared/types';
import type { BookDigest } from '../books/types';
import { languageName } from '../shared/languages';
import { EXPLAIN_PROPERTIES, structured } from '../background/claude';
import { estimateTokens } from '../books/text-utils';

export interface BookMeta {
  title: string;
  author?: string;
  lang: string;
}

export type BookExplain = ExplainResult & { bookNote: string };

// Approximate list prices per million input tokens (for the cost estimate shown before analysing).
const INPUT_PRICE: Record<string, (tokens: number) => number> = {
  'claude-opus-5-5': () => 4,
  'claude-sonnet-5-5': () => 2,
  'claude-haiku-5-5': (t) => (t > 100_000 ? 0.5 : 0.1),
};

export function estimateDigestCost(text: string, model: string): { tokens: number; usd: number } {
  const tokens = estimateTokens(text);
  const price = INPUT_PRICE[model]?.(tokens) ?? 4;
  return { tokens, usd: (tokens / 1_000_000) * price + 0.05 };
}

const DIGEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['premise', 'summary', 'characters', 'places', 'glossary', 'style'],
  properties: {
    premise: { type: 'string', description: 'Spoiler-free premise (what the book is about at the start), under 120 words' },
    summary: { type: 'string', description: 'Full plot summary with spoilers, under 450 words' },
    characters: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description'],
        properties: { name: { type: 'string' }, description: { type: 'string', description: 'Who they are when first introduced; no later spoilers' } },
      },
    },
    places: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['name', 'description'], properties: { name: { type: 'string' }, description: { type: 'string' } } },
    },
    glossary: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['term', 'meaning'],
        properties: { term: { type: 'string', description: 'As written in the book' }, meaning: { type: 'string' } },
      },
    },
    style: { type: 'string', description: 'Register, era, dialect, narrative voice and anything unusual about the language' },
  },
};

type DigestJson = Omit<BookDigest, 'model' | 'createdAt'>;

function digestSystem(book: BookMeta, native: string): string {
  return (
    `You prepare reading notes for someone learning ${languageName(book.lang)} who is reading a whole book in that language. ` +
    `Read the entire text and write the notes in ${languageName(native)}. ` +
    `The glossary is what makes the notes useful: include the book's invented or unusual words, slang, regional or archaic terms, ` +
    `nicknames and recurring expressions whose meaning depends on this book (term as written in the book, meaning in ${languageName(native)}). ` +
    `At most 25 characters, 15 places and 60 glossary entries.`
  );
}

/** Split text into parts of at most ~maxTokens, on paragraph boundaries. */
function splitByTokens(text: string, maxTokens: number): string[] {
  const parts: string[] = [];
  let cur = '';
  for (const para of text.split('\n\n')) {
    if (cur && estimateTokens(cur) + estimateTokens(para) > maxTokens) {
      parts.push(cur);
      cur = '';
    }
    cur += (cur ? '\n\n' : '') + para;
  }
  if (cur) parts.push(cur);
  return parts;
}

export async function digestBook(apiKey: string, model: string, book: BookMeta, text: string, native: string, onProgress?: (done: number, total: number) => void): Promise<BookDigest> {
  if (__TEST__ && apiKey === 'mock') return mockDigest(book, model);
  const header = `<book title="${book.title}"${book.author ? ` author="${book.author}"` : ''}>`;
  // Books that do not fit comfortably in one request are read in parts, then merged.
  const parts = estimateTokens(text) <= 600_000 ? [text] : splitByTokens(text, 400_000);
  const partials: DigestJson[] = [];
  for (const [i, part] of parts.entries()) {
    onProgress?.(i, parts.length + (parts.length > 1 ? 1 : 0));
    partials.push(
      await structured<DigestJson>(apiKey, model, {
        system: digestSystem(book, native),
        user: `${header}\n${parts.length > 1 ? `[Part ${i + 1} of ${parts.length}]\n` : ''}${part}\n</book>\n\nWrite the reading notes.`,
        schema: DIGEST_SCHEMA,
        maxTokens: 16000,
        effort: 'medium',
        stream: true,
        timeoutMs: 15 * 60_000,
      }),
    );
  }
  let final = partials[0];
  if (partials.length > 1) {
    onProgress?.(parts.length, parts.length + 1);
    final = await structured<DigestJson>(apiKey, model, {
      system: digestSystem(book, native),
      user: `These are reading notes written for consecutive parts of the same book. Merge them into a single set of notes for the whole book.\n\n${JSON.stringify(partials)}`,
      schema: DIGEST_SCHEMA,
      maxTokens: 16000,
      effort: 'medium',
      stream: true,
    });
  }
  return { ...final, model, createdAt: Date.now() };
}

function digestContext(book: BookMeta, d: BookDigest): string {
  const list = (items: { name?: string; term?: string; description?: string; meaning?: string }[]) =>
    items.map((x) => `- ${x.name ?? x.term}: ${x.description ?? x.meaning}`).join('\n');
  return [
    `<book title="${book.title}"${book.author ? ` author="${book.author}"` : ''}>`,
    `<summary>${d.summary}</summary>`,
    d.characters.length ? `<characters>\n${list(d.characters)}\n</characters>` : '',
    d.places.length ? `<places>\n${list(d.places)}\n</places>` : '',
    d.glossary.length ? `<glossary>\n${list(d.glossary)}\n</glossary>` : '',
    `<style>${d.style}</style>`,
    '</book>',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Short context for translating passages consistently (names and special terms). */
export function translationContext(book: BookMeta, d?: BookDigest): string | undefined {
  if (!d) return undefined;
  const terms = d.glossary.slice(0, 40).map((g) => `${g.term}: ${g.meaning}`).join('; ');
  return `${book.title}${book.author ? ` (${book.author})` : ''}. ${d.premise}${terms ? `\nTerms: ${terms}` : ''}`;
}

const BOOK_EXPLAIN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [...Object.keys(EXPLAIN_PROPERTIES), 'bookNote'],
  properties: {
    ...EXPLAIN_PROPERTIES,
    bookNote: { type: 'string', description: 'How this word relates to this book (character, invented term, recurring motif, period usage); empty string if nothing specific' },
  },
};

export async function explainInBook(
  apiKey: string,
  model: string,
  book: BookMeta,
  digest: BookDigest | undefined,
  native: string,
  word: string,
  sentence: string,
  passage: string,
  chapter: string,
): Promise<BookExplain> {
  if (__TEST__ && apiKey === 'mock') return mockExplain(word, sentence, digest);
  const L = languageName(book.lang);
  const N = languageName(native);
  const instructions =
    `You are a concise language tutor. The learner is a ${N} speaker reading «${book.title}» in ${L} and clicked a word or phrase. ` +
    `Explain what it means in this exact passage, using what you know about the book (characters, setting, invented terms, period and register) when it matters. ` +
    `Write explanations in ${N}; keep examples in ${L}. Be brief: meaning under 30 words, grammar under 45 words, at most 3 other meanings and 2 short examples. ` +
    `Never reveal plot events that happen after this passage.`;
  const system = digest
    ? [
        { type: 'text' as const, text: instructions },
        // The book notes are the same for every lookup: cache them.
        { type: 'text' as const, text: digestContext(book, digest), cache_control: { type: 'ephemeral' as const } },
      ]
    : instructions;
  const user = `Chapter: ${chapter}\nPassage:\n«${passage}»\n\nSentence: «${sentence}»\nWord or phrase: «${word}»`;
  return structured<BookExplain>(apiKey, model, { system, user, schema: BOOK_EXPLAIN_SCHEMA, maxTokens: 4000 });
}

// ---------------------------------------------------------------- test-build mocks

function mockDigest(book: BookMeta, model: string): BookDigest {
  return {
    premise: `Mock premise of ${book.title}.`,
    summary: `Mock full summary of ${book.title}.`,
    characters: [{ name: 'Alice', description: 'A curious girl.' }],
    places: [{ name: 'Wonderland', description: 'A strange land.' }],
    glossary: [{ term: 'mome raths', meaning: 'Invented creatures.' }],
    style: 'Victorian English.',
    model,
    createdAt: Date.now(),
  };
}

function mockExplain(word: string, sentence: string, digest?: BookDigest): BookExplain {
  return {
    lemma: word.toLowerCase(),
    reading: '',
    partOfSpeech: 'noun',
    meaning: `Book meaning of ${word}`,
    grammar: 'Mock grammar.',
    otherMeanings: [],
    examples: [],
    sentenceTranslation: `[es] ${sentence}`,
    bookNote: digest ? `Appears in ${digest.characters[0]?.name ?? 'the book'}'s story.` : '',
  };
}
