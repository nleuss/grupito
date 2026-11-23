// Tiny IndexedDB key/value cache used by the service worker (translations, lookups, explanations).

const DB_NAME = 'vidioma-cache';
const STORE = 'kv';
let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => (dbPromise = null));
  }
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return db().then(
    (d) =>
      new Promise<T | undefined>((resolve, reject) => {
        const t = d.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        const req = fn(store);
        t.oncomplete = () => resolve(req ? (req.result as T) : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export async function cacheGetMany<T>(keys: string[]): Promise<(T | undefined)[]> {
  if (!keys.length) return [];
  try {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const t = d.transaction(STORE, 'readonly');
      const store = t.objectStore(STORE);
      const out: (T | undefined)[] = new Array(keys.length);
      keys.forEach((k, i) => {
        const r = store.get(k);
        r.onsuccess = () => (out[i] = r.result as T | undefined);
      });
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
    });
  } catch {
    return keys.map(() => undefined);
  }
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  return (await cacheGetMany<T>([key]))[0];
}

export async function cacheSetMany(entries: [string, unknown][]): Promise<void> {
  if (!entries.length) return;
  try {
    await tx('readwrite', (s) => {
      for (const [k, v] of entries) s.put(v, k);
    });
  } catch {
    /* cache is best effort */
  }
}

export async function cacheSet(key: string, value: unknown): Promise<void> {
  await cacheSetMany([[key, value]]);
}

export async function cacheClear(): Promise<void> {
  await tx('readwrite', (s) => s.clear());
}
