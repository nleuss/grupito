// Data model for the book reader.

export interface Paragraph {
  /** Text of the paragraph (single line, no hard line breaks). */
  t: string;
  /** Heading level (1–3) for titles; absent for body text. */
  h?: 1 | 2 | 3;
  /** Source page (PDF) for "page N" references. */
  p?: number;
}

export interface Section {
  title: string;
  paragraphs: Paragraph[];
}

export interface BookDigest {
  /** Spoiler-free premise (shown to the reader). */
  premise: string;
  /** Full plot summary with spoilers (AI context; shown only on request). */
  summary: string;
  characters: { name: string; description: string }[];
  places: { name: string; description: string }[];
  glossary: { term: string; meaning: string }[];
  style: string;
  model: string;
  createdAt: number;
}

export interface Book {
  id: string;
  title: string;
  author?: string;
  /** Language the book is written in (the language being learned). */
  lang: string;
  format: 'pdf' | 'epub' | 'txt' | 'html';
  sections: Section[];
  chars: number;
  addedAt: number;
  openedAt: number;
  position: { section: number; paragraph: number };
  digest?: BookDigest;
}

export type BookSummary = Omit<Book, 'sections' | 'digest'> & { hasDigest: boolean; progress: number };

export interface ParsedBook {
  title: string;
  author?: string;
  lang?: string;
  sections: Section[];
}
