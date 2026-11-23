// Book library in IndexedDB (extension origin). Metadata (position, digest) and the full text are
// kept in separate stores so saving the reading position never rewrites the whole book.
import type { Book, BookSummary, Section } from './types';

const DB = 'vidioma-books';
const META = 'books';
const TEXT = 'texts';
let dbp: Promise<IDBDatabase> | null = null;

type BookMetaRecord = Omit<Book, 'sections'> & { counts: number[] };

function db(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 2);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath: 'id' });
        if (!d.objectStoreNames.contains(TEXT)) d.createObjectStore(TEXT, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbp.catch(() => (dbp = null));
  }
  return dbp;
}

function tx<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(stores, mode);
        const req = fn(t);
        t.oncomplete = () => resolve(req ? req.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

function toMeta(book: Book): BookMetaRecord {
  const { sections, ...meta } = book;
  return { ...meta, counts: sections.map((s) => s.paragraphs.length) };
}

export async function saveBook(book: Book): Promise<Book> {
  await tx([META, TEXT], 'readwrite', (t) => {
    t.objectStore(META).put(toMeta(book));
    t.objectStore(TEXT).put({ id: book.id, sections: book.sections });
  });
  return book;
}

export async function getBook(id: string): Promise<Book | undefined> {
  let meta: BookMetaRecord | undefined;
  let text: { sections: Section[] } | undefined;
  await tx([META, TEXT], 'readonly', (t) => {
    const a = t.objectStore(META).get(id);
    const b = t.objectStore(TEXT).get(id);
    a.onsuccess = () => (meta = a.result);
    b.onsuccess = () => (text = b.result);
  });
  if (!meta || !text) return undefined;
  const { counts: _counts, ...rest } = meta;
  return { ...rest, sections: text.sections };
}

/** Update metadata (position, language, digest…). The text itself is immutable once imported. */
export async function updateBook(id: string, patch: Partial<Omit<Book, 'sections' | 'id'>>): Promise<Book | undefined> {
  const meta = await tx<BookMetaRecord>([META], 'readonly', (t) => t.objectStore(META).get(id) as IDBRequest<BookMetaRecord>);
  if (!meta) return undefined;
  await tx([META], 'readwrite', (t) => {
    t.objectStore(META).put({ ...meta, ...patch, id });
  });
  return getBook(id);
}

export async function deleteBook(id: string): Promise<void> {
  await tx([META, TEXT], 'readwrite', (t) => {
    t.objectStore(META).delete(id);
    t.objectStore(TEXT).delete(id);
  });
}

export async function listBooks(): Promise<BookSummary[]> {
  const all = ((await tx<BookMetaRecord[]>([META], 'readonly', (t) => t.objectStore(META).getAll() as IDBRequest<BookMetaRecord[]>)) ?? []) as BookMetaRecord[];
  return all
    .map(({ counts, digest, ...rest }) => {
      const total = counts.reduce((a, n) => a + n, 0) || 1;
      const before = counts.slice(0, rest.position.section).reduce((a, n) => a + n, 0) + rest.position.paragraph;
      return { ...rest, hasDigest: !!digest, progress: Math.min(1, before / total) };
    })
    .sort((a, b) => b.openedAt - a.openedAt);
}
