// Buffers records in IndexedDB, or in memory if IndexedDB fails.
const DB_NAME = 'c1-capture';
const STORE = 'records';

// Never throws: problems go to onError and records fall back to memory.
export async function openStorage({ idb = globalThis.indexedDB, onError = () => {} } = {}) {
  const memory = [];
  let db = null;
  try {
    db = await openDb(idb);
  } catch (err) {
    onError(describe('open', err));
  }

  return {
    get usingMemory() { return db === null; },

    async append(record) {
      if (db) {
        try {
          await inTransaction(db, 'readwrite', (store) => store.add(record));
          return;
        } catch (err) {
          onError(describe('save', err));
        }
      }
      memory.push(record);
    },

    async readAll() {
      let saved = [];
      if (db) {
        try {
          saved = await inTransaction(db, 'readonly', (store) => store.getAll());
        } catch (err) {
          onError(describe('read', err));
        }
      }
      return [...saved, ...memory];
    },

    async clear() {
      memory.length = 0;
      if (db) {
        try {
          await inTransaction(db, 'readwrite', (store) => store.clear());
        } catch (err) {
          onError(describe('clear', err));
        }
      }
    },
  };
}

function openDb(idb) {
  return new Promise((resolve, reject) => {
    if (!idb) throw new Error('IndexedDB is not available in this browser');
    const req = idb.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB was blocked by another open tab'));
  });
}

function inTransaction(db, mode, makeRequest) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = makeRequest(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(req.error ?? tx.error ?? new Error('transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

function describe(action, err) {
  const name = err?.name ?? 'Error';
  const detail = err?.message ? `: ${err.message}` : '';
  const keep = action === 'open' || action === 'save'
    ? ' Records are kept in memory only and will be lost on reload.'
    : '';
  return `Storage ${action} failed (${name}${detail}).${keep}`;
}
