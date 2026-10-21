// Tests for src/storage.js (run from capture_client/ with npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStorage } from '../src/storage.js';

// A fake IndexedDB that can fail to open or to write.
function fakeIndexedDB({ failOpen = null, failWrite = null, data = new Map() } = {}) {
  const db = {
    transaction(name, mode) {
      const tx = {};
      const rows = data.get(name);
      const done = (req) => { queueMicrotask(() => tx.oncomplete?.()); return req; };
      tx.objectStore = () => ({
        add(value) {
          if (failWrite) {
            tx.error = failWrite;
            queueMicrotask(() => tx.onabort?.());
            return {};
          }
          rows.push(structuredClone(value));
          return done({ result: rows.length });
        },
        getAll: () => done({ result: rows.map((r) => structuredClone(r)) }),
        clear: () => { rows.length = 0; return done({}); },
      });
      if (mode !== 'readonly' && mode !== 'readwrite') throw new Error('bad mode');
      return tx;
    },
    createObjectStore(name) { data.set(name, []); },
  };
  return {
    data,
    open() {
      const req = {};
      queueMicrotask(() => {
        if (failOpen) { req.error = failOpen; req.onerror?.(); return; }
        req.result = db;
        if (!data.has('records')) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

const rec = (seq) => ({ schema_version: '0.1', session_id: 'S1', type: 'session_stop', seq });

test('saves and reads records in order, and clear empties the buffer', async () => {
  const errors = [];
  const s = await openStorage({ idb: fakeIndexedDB(), onError: (m) => errors.push(m) });
  for (const seq of [0, 1, 2]) await s.append(rec(seq));
  assert.deepEqual((await s.readAll()).map((r) => r.seq), [0, 1, 2]);
  await s.clear();
  assert.deepEqual([(await s.readAll()).length, s.usingMemory, errors.length], [0, false, 0]);
});

test('the buffer survives a reload (a second open sees the first page\'s records)', async () => {
  const idb = fakeIndexedDB();
  const before = await openStorage({ idb });
  await before.append(rec(0));
  await before.append(rec(1));
  const after = await openStorage({ idb });
  assert.deepEqual((await after.readAll()).map((r) => r.seq), [0, 1]);
});

test('no IndexedDB at all: the error is reported and records stay in memory', async () => {
  const errors = [];
  const s = await openStorage({ idb: null, onError: (m) => errors.push(m) });
  await s.append(rec(0));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Storage open failed \(Error: IndexedDB is not available in this browser\)\. .*lost on reload/);
  assert.deepEqual([s.usingMemory, (await s.readAll()).length], [true, 1]);
});

test('IndexedDB refuses to open: the error is reported and records stay in memory', async () => {
  const errors = [];
  const s = await openStorage({ idb: fakeIndexedDB({ failOpen: new DOMException('denied', 'SecurityError') }), onError: (m) => errors.push(m) });
  await s.append(rec(0));
  assert.match(errors[0], /Storage open failed \(SecurityError: denied\)/);
  assert.deepEqual([s.usingMemory, (await s.readAll()).map((r) => r.seq)], [true, [0]]);
});

test('a save that fails (quota full) is reported and the record is kept in memory', async () => {
  const errors = [];
  const idb = fakeIndexedDB({ failWrite: new DOMException('full', 'QuotaExceededError') });
  const s = await openStorage({ idb, onError: (m) => errors.push(m) });
  await s.append(rec(0));
  await s.append(rec(1));
  assert.equal(errors.length, 2);
  assert.match(errors[0], /Storage save failed \(QuotaExceededError: full\)\. .*lost on reload/);
  assert.deepEqual((await s.readAll()).map((r) => r.seq), [0, 1]);
});
