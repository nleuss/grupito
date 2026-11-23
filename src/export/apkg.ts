// Builds an Anki package (.apkg): a zip with a SQLite collection (legacy "anki2" schema,
// importable by Anki desktop, AnkiDroid and AnkiMobile) plus numbered media files.
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { strToU8, zipSync } from 'fflate';
import { BACK, CSS, FIELDS, FRONT, MODEL_NAME, type NoteFields } from './anki-model';

export interface ApkgNote {
  fields: NoteFields;
  tags?: string[];
}
export interface ApkgMedia {
  name: string;
  data: Uint8Array;
}

const SCHEMA = `
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_notes_csum on notes (csum);
`;

let sqlPromise: Promise<SqlJsStatic> | null = null;
export function loadSql(locate?: (f: string) => string): Promise<SqlJsStatic> {
  if (!sqlPromise) sqlPromise = initSqlJs({ locateFile: locate ?? ((f) => chrome.runtime.getURL(`vendor/${f}`)) });
  return sqlPromise;
}

/** Stable positive 53-bit-safe id derived from a string (deck / model ids). */
function stableId(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return 1_500_000_000_000 + (Math.abs(h) % 400_000_000_000);
}

const BASE91 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~';
function guid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => BASE91[b % BASE91.length]).join('');
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

async function checksum(field: string): Promise<number> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(stripHtml(field)));
  const b = new Uint8Array(digest);
  return ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3];
}

export async function buildApkg(deckName: string, notes: ApkgNote[], media: ApkgMedia[] = [], sql?: SqlJsStatic): Promise<Uint8Array<ArrayBuffer>> {
  const SQL = sql ?? (await loadSql());
  const db = new SQL.Database();
  db.run(SCHEMA);
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  const deckId = stableId(`deck:${deckName}`);
  const modelId = stableId(`model:${MODEL_NAME}:${FIELDS.join(',')}`);

  const model = {
    id: modelId,
    name: MODEL_NAME,
    type: 0,
    mod: now,
    usn: -1,
    sortf: 0,
    did: deckId,
    tmpls: [{ name: 'Card 1', ord: 0, qfmt: FRONT, afmt: BACK, did: null, bqfmt: '', bafmt: '' }],
    flds: FIELDS.map((name, ord) => ({ name, ord, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] })),
    css: CSS,
    latexPre: '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n',
    latexPost: '\\end{document}',
    tags: [],
    vers: [],
    req: [[0, 'any', [0]]],
  };
  const deck = (id: number, name: string) => ({
    id,
    name,
    desc: '',
    mod: now,
    usn: -1,
    conf: 1,
    dyn: 0,
    collapsed: false,
    browserCollapsed: false,
    extendNew: 10,
    extendRev: 50,
    newToday: [0, 0],
    revToday: [0, 0],
    lrnToday: [0, 0],
    timeToday: [0, 0],
  });
  const dconf = {
    1: {
      id: 1,
      name: 'Default',
      mod: 0,
      usn: 0,
      maxTaken: 60,
      autoplay: true,
      timer: 0,
      replayq: true,
      new: { bury: true, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 7], order: 1, perDay: 20, separate: true },
      rev: { bury: true, ease4: 1.3, fuzz: 0.05, ivlFct: 1, maxIvl: 36500, minSpace: 1, perDay: 200 },
      lapse: { delays: [10], leechAction: 0, leechFails: 8, minInt: 1, mult: 0 },
    },
  };
  const conf = { activeDecks: [1], addToCur: true, collapseTime: 1200, curDeck: 1, curModel: String(modelId), dueCounts: true, estTimes: true, newBury: true, newSpread: 0, nextPos: 1, sortBackwards: false, sortType: 'noteFld', timeLim: 0 };

  db.run('INSERT INTO col VALUES (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, ?)', [
    now,
    nowMs,
    nowMs,
    JSON.stringify(conf),
    JSON.stringify({ [modelId]: model }),
    JSON.stringify({ 1: deck(1, 'Default'), [deckId]: deck(deckId, deckName) }),
    JSON.stringify(dconf),
    '{}',
  ]);

  const insNote = db.prepare("INSERT INTO notes VALUES (?, ?, ?, ?, -1, ?, ?, ?, ?, 0, '')");
  const insCard = db.prepare("INSERT INTO cards VALUES (?, ?, ?, 0, ?, -1, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, '')");
  let id = nowMs;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const flds = FIELDS.map((f) => n.fields[f] ?? '');
    const tags = n.tags?.length ? ` ${n.tags.map((t) => t.replace(/\s+/g, '_')).join(' ')} ` : '';
    const noteId = id++;
    insNote.run([noteId, guid(), modelId, now, tags, flds.join('\x1f'), stripHtml(flds[0]), await checksum(flds[0])]);
    insCard.run([id++, noteId, deckId, now, i + 1]);
  }
  insNote.free();
  insCard.free();
  const collection = db.export();
  db.close();

  const mediaMap: Record<string, string> = {};
  const files: Record<string, Uint8Array> = { 'collection.anki2': collection };
  media.forEach((m, i) => {
    mediaMap[String(i)] = m.name;
    files[String(i)] = m.data;
  });
  files.media = strToU8(JSON.stringify(mediaMap));
  return zipSync(files, { level: 6 }) as Uint8Array<ArrayBuffer>;
}
