// Vocabulary storage in chrome.storage.local (one key per item, so concurrent tabs don't clobber each other).
import type { VocabItem } from './types';
import { baseLang } from './languages';
import { uid } from './util';

const PREFIX = 'vocab:';

export async function listVocab(): Promise<VocabItem[]> {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(PREFIX))
    .map(([, v]) => v as VocabItem)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function addVocab(item: Omit<VocabItem, 'id' | 'createdAt' | 'updatedAt' | 'status'> & Partial<VocabItem>): Promise<VocabItem> {
  const existing = await findVocab(item.lang, item.text, item.kind);
  const now = Date.now();
  if (existing) {
    const merged: VocabItem = { ...existing, ...stripUndefined(item), id: existing.id, createdAt: existing.createdAt, updatedAt: now };
    await chrome.storage.local.set({ [PREFIX + merged.id]: merged });
    return merged;
  }
  const full: VocabItem = { status: 'new', ...stripUndefined(item), id: uid('v'), createdAt: now, updatedAt: now } as VocabItem;
  await chrome.storage.local.set({ [PREFIX + full.id]: full });
  return full;
}

export async function updateVocab(id: string, patch: Partial<VocabItem>): Promise<void> {
  const key = PREFIX + id;
  const cur = (await chrome.storage.local.get(key))[key] as VocabItem | undefined;
  if (!cur) return;
  await chrome.storage.local.set({ [key]: { ...cur, ...patch, id, updatedAt: Date.now() } });
}

export async function deleteVocab(ids: string[]): Promise<void> {
  await chrome.storage.local.remove(ids.map((id) => PREFIX + id));
}

export async function importVocab(items: VocabItem[]): Promise<number> {
  const entries: Record<string, VocabItem> = {};
  for (const raw of items) {
    const it = raw as Partial<VocabItem>;
    if (!it || typeof it.text !== 'string' || typeof it.lang !== 'string') continue;
    const id = it.id || uid('v');
    entries[PREFIX + id] = { status: 'new', createdAt: Date.now(), updatedAt: Date.now(), kind: 'word', ...it, id } as VocabItem;
  }
  await chrome.storage.local.set(entries);
  return Object.keys(entries).length;
}

async function findVocab(lang: string, text: string, kind: VocabItem['kind']): Promise<VocabItem | undefined> {
  const norm = normalizeWord(text);
  return (await listVocab()).find((v) => v.kind === kind && baseLang(v.lang) === baseLang(lang) && normalizeWord(v.text) === norm);
}

export function normalizeWord(w: string): string {
  return w
    .normalize('NFC')
    .toLocaleLowerCase()
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '');
}

/** Set of normalized saved words (and lemmas) for one language, for highlighting. */
export async function savedWordSet(lang: string): Promise<Set<string>> {
  const set = new Set<string>();
  for (const v of await listVocab()) {
    if (v.kind !== 'word' || baseLang(v.lang) !== baseLang(lang) || v.status === 'known') continue;
    set.add(normalizeWord(v.text));
    if (v.lemma) set.add(normalizeWord(v.lemma));
  }
  return set;
}

export function onVocabChanged(cb: () => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && Object.keys(changes).some((k) => k.startsWith(PREFIX))) cb();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
