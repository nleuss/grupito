// AnkiConnect (https://ankiweb.net/shared/info/2055492159): add notes straight into a running Anki.
import { BACK, CSS, FIELDS, FRONT, MODEL_NAME, type NoteFields } from './anki-model';

const URL = 'http://127.0.0.1:8765';

async function invoke<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(URL, { method: 'POST', body: JSON.stringify({ action, version: 6, params }) });
  if (!res.ok) throw new Error(`AnkiConnect HTTP ${res.status}`);
  const data = (await res.json()) as { result: T; error: string | null };
  if (data.error) throw new Error(data.error);
  return data.result;
}

export async function sendNotesToAnki(deck: string, notes: { fields: NoteFields; tags: string[] }[]): Promise<number> {
  const perm = await invoke<{ permission: string }>('requestPermission');
  if (perm?.permission !== 'granted') throw new Error('Anki denied access (AnkiConnect permission)');
  await invoke('createDeck', { deck });
  const models = await invoke<string[]>('modelNames');
  if (!models.includes(MODEL_NAME)) {
    await invoke('createModel', {
      modelName: MODEL_NAME,
      inOrderFields: [...FIELDS],
      css: CSS,
      isCloze: false,
      cardTemplates: [{ Name: 'Card 1', Front: FRONT, Back: BACK }],
    });
  }
  const result = await invoke<(number | null)[]>('addNotes', {
    notes: notes.map((n) => ({
      deckName: deck,
      modelName: MODEL_NAME,
      fields: n.fields,
      tags: n.tags,
      options: { allowDuplicate: false, duplicateScope: 'deck' },
    })),
  });
  return result.filter((x) => x != null).length;
}
