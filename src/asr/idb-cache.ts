// IndexedDB-backed cache for @xenova/transformers.
//
// transformers.js already has a Cache-API cache, but that is subject to the
// browser evicting it under storage pressure and it is awkward to inspect.
// The user asked for downloads to persist, so this implements the same
// `match`/`put` contract the library expects (see utils/hub.js `tryCache`
// and its `cache.put(cacheKey, new Response(...))` call) on top of
// IndexedDB, which is durable and origin-scoped.
//
// Semantics that matter to the library:
//   * `match` MUST resolve to `undefined` on a miss (not throw) — hub.js
//     does `await cache.match(cacheKey) === undefined` before writing.
//   * `put` is allowed to reject (e.g. quota) — hub.js catches and warns.

const DB_NAME = "bn-en-asr-model-cache";
const STORE = "files";
const DB_VERSION = 1;

interface CacheRecord {
  key: string;
  body: ArrayBuffer;
  status: number;
  statusText: string;
  headers: [string, string][];
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open model cache DB"));
  });
}

export interface ModelCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
  /** Total bytes currently cached (for diagnostics/UI). */
  usedBytes(): Promise<number>;
  clear(): Promise<void>;
}

export function createIndexedDbCache(): ModelCache {
  let dbPromise: Promise<IDBDatabase> | null = null;

  function db(): Promise<IDBDatabase> {
    dbPromise ??= openDb();
    return dbPromise;
  }

  async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T>): Promise<T> {
    const database = await db();
    const tx = database.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    return fn(store);
  }

  return {
    async match(key: string): Promise<Response | undefined> {
      const record = await withStore("readonly", (store) => promisify<CacheRecord | undefined>(store.get(key)));
      if (!record) return undefined;
      return new Response(record.body, {
        status: record.status,
        statusText: record.statusText,
        headers: record.headers,
      });
    },

    async put(key: string, response: Response): Promise<void> {
      // Read the body before the transaction, since the transaction may
      // auto-close while we await the stream.
      const body = await response.arrayBuffer();
      const headers: [string, string][] = [];
      response.headers.forEach((value, name) => headers.push([name, value]));

      const record: CacheRecord = {
        key,
        body,
        status: response.status,
        statusText: response.statusText,
        headers,
      };
      await withStore("readwrite", (store) => promisify(store.put(record)));
    },

    async usedBytes(): Promise<number> {
      const records = await withStore("readonly", (store) => promisify<CacheRecord[]>(store.getAll()));
      return records.reduce((total, r) => total + (r.body?.byteLength ?? 0), 0);
    },

    async clear(): Promise<void> {
      await withStore("readwrite", (store) => promisify(store.clear()));
    },
  };
}
