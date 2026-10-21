// Tests for src/export.js (run from capture_client/ with npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SCHEMA_VERSION, ENVELOPE, ALLOWED, checkRecord, platformFrom, createWriter, toJsonLines,
  resumeOrStartSession, saveSession, endSession, stashRecord, takeStash,
} from '../src/export.js';

const UA = {
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  edgeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  firefoxWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  unknown: 'curl/8.0',
};
const PLATFORM = platformFrom(UA.chromeWin);
const T0 = 1791800000000.5;

test('platform: device class, OS, browser and major version from the user agent', () => {
  const p = (ua) => Object.values(platformFrom(ua));
  assert.deepEqual(p(UA.chromeWin), ['laptop', 'windows', 'chrome', 141]);
  assert.deepEqual(p(UA.edgeWin), ['laptop', 'windows', 'edge', 141]);
  assert.deepEqual(p(UA.firefoxWin), ['laptop', 'windows', 'firefox', 143]);
  assert.deepEqual(p(UA.chromeAndroid), ['mobile', 'android', 'chrome', 141]);
  assert.deepEqual(p(UA.safariIphone), ['mobile', 'ios', 'safari', 18]);
  assert.deepEqual(p(UA.safariMac), ['laptop', 'macos', 'safari', 18]);
  assert.deepEqual(p(UA.unknown), ['laptop', 'other', 'other', null]);
});

test('platform: only 4 coarse fields, never the user-agent string; uaData.mobile wins', () => {
  const p = platformFrom(UA.chromeWin);
  assert.deepEqual(Object.keys(p), ['device_class', 'os_family', 'browser_family', 'browser_major']);
  assert.equal(JSON.stringify(p).includes('Mozilla'), false);
  assert.equal(platformFrom(UA.chromeWin, { mobile: true }).device_class, 'mobile');
});

test('writer: a new session in schema form, with t_ms and seq', () => {
  const w = createWriter({ sessionId: 'S1', participantId: 'T-ABCDEFGH', timeOrigin: T0, platform: PLATFORM });
  const recs = [
    w.fromSignal({ type: 'start', t: 73.5, wall_ms: 1791800000074 }),
    w.fromSignal({ type: 'visibility', state: 'visible', t: 73.5, initial: true }),
    w.fromSignal({ type: 'focus', state: 'focus', t: 73.5, initial: true }),
    w.fromSignal({ type: 'focus', state: 'blur', t: 2500 }),
    w.fromRow({ t: 1073.5, bucket_ms: 1000, pointer_count: 24, pointer_slots: 3, touch_count: 0, touch_slots: 0, key_count: 2, key_slots: 2, proc_ms: 0.4 },
      { hasFocus: true, wallMs: 1791800001074 }),
    w.fromSignal({ type: 'stop', t: 4000 }),
  ];
  assert.deepEqual(recs.map((r) => r.type), ['session_start', 'visibility', 'focus', 'focus', 'tick', 'session_stop']);
  assert.deepEqual(recs.map((r) => r.seq), [0, 1, 2, 3, 4, 5]);
  assert.equal(w.nextSeq, 6);
  assert.equal(recs[0].t_ms, 1791800000074);
  assert.equal(recs[5].t_ms, 1791800004000.5);
  for (const r of recs) assert.deepEqual([r.schema_version, r.session_id, r.participant_id, r.source], ['0.1', 'S1', 'T-ABCDEFGH', 'c1']);
  assert.deepEqual(
    [recs[0].time_origin_ms, recs[0].wall_ms, recs[0].device_class, recs[0].browser_family, recs[0].browser_major],
    [T0, 1791800000074, 'laptop', 'chrome', 141],
  );
  assert.deepEqual(recs.map((r) => r.initial), [undefined, true, true, undefined, undefined, undefined]);
  assert.deepEqual([recs[4].pointer_count, recs[4].key_slots, recs[4].proc_ms, recs[4].has_focus, 't' in recs[4]], [24, 2, 0.4, true, false]);
});

test('writer: after a reload, start becomes page_load and seq continues', () => {
  const w = createWriter({ sessionId: 'S1', participantId: 'T-ABCDEFGH', timeOrigin: 1791800060000, nextSeq: 57, resumed: true, platform: PLATFORM });
  const r = w.fromSignal({ type: 'start', t: 12, wall_ms: 1791800060012 });
  assert.deepEqual([r.type, r.seq, r.t_ms, r.time_origin_ms, r.wall_ms], ['page_load', 57, 1791800060012, 1791800060000, 1791800060012]);
  assert.equal('device_class' in r, false);
});

test('writer: pagehide becomes page_hide with its persisted flag', () => {
  const w = createWriter({ sessionId: 'S1', participantId: 'T-ABCDEFGH', timeOrigin: T0, platform: PLATFORM });
  const r = w.fromSignal({ type: 'pagehide', t: 9000, persisted: false });
  assert.deepEqual([r.type, r.t_ms, r.seq, r.persisted], ['page_hide', 1791800009000.5, 0, false]);
});

test('writer: a classifier state gets the window end on the epoch clock (D041)', () => {
  const w = createWriter({ sessionId: 'S1', participantId: 'T-ABCDEFGH', timeOrigin: T0, platform: PLATFORM });
  const r = w.fromState(30002.5, { window_end: 30000, window_ms: 30000, state: 'present', confidence: 0.9,
    model_version: 'l1-lr-abc', latency_ms: 2.5, compute_ms: 0.4 });
  assert.deepEqual([r.type, r.t_ms, r.window_end_ms, r.latency_ms], ['state', 1791800030003, 1791800030000.5, 2.5]);
  assert.equal(r.t_ms - r.window_end_ms, r.latency_ms);
  assert.throws(() => w.fromState(1, { window_end: 0, features: [1] }), /Field features is not allowed in state/);
});

test('writer: a field outside the schema is refused and leaves a gap in seq', () => {
  const w = createWriter({ sessionId: 'S1', participantId: 'T-ABCDEFGH', timeOrigin: T0, platform: PLATFORM });
  const leaky = { t: 1000, bucket_ms: 1000, pointer_count: 1, pointer_slots: 1, touch_count: 0, touch_slots: 0, key_count: 1, key_slots: 1, key: 'a' };
  assert.throws(() => w.fromRow(leaky, { hasFocus: true, wallMs: 0 }), /Field key is not allowed in tick/);
  assert.equal(w.fromSignal({ type: 'stop', t: 2000 }).seq, 1);
});

test('checkRecord: missing envelope fields and unknown types are refused', () => {
  assert.throws(() => checkRecord({ type: 'session_stop' }), /Missing envelope field/);
  const env = { schema_version: '0.1', session_id: 'S', participant_id: 'P', source: 'c1', t_ms: 1, seq: 0 };
  assert.throws(() => checkRecord({ ...env, type: 'screenshot' }), /Unknown record type/);
  assert.doesNotThrow(() => checkRecord({ ...env, type: 'session_stop' }));
});

test('JSON Lines: one session, seq order, one parsable object per line', () => {
  const env = (session_id, seq) => ({ schema_version: '0.1', session_id, participant_id: 'P', source: 'c1', type: 'session_stop', t_ms: seq, seq });
  const records = [env('S1', 2), env('S2', 0), env('S1', 0), env('S1', 1)];
  const text = toJsonLines(records, 'S1');
  const lines = text.split('\n');
  assert.equal(lines.at(-1), '');
  assert.deepEqual(lines.slice(0, -1).map((l) => JSON.parse(l).seq), [0, 1, 2]);
});

test('the allow-list matches docs/design/event_schema_v0.1.md', () => {
  const doc = readFileSync(new URL('../../docs/design/event_schema_v0.1.md', import.meta.url), 'utf8');
  const fields = {};
  let section = null;
  for (const line of doc.split('\n')) {
    const h = line.match(/^##+ (?:`(\w+)`|Envelope)/);
    if (h) { section = h[1] ?? 'envelope'; fields[section] = []; continue; }
    const row = line.match(/^\| `(\w+)`/);
    if (row && section) fields[section].push(row[1]);
  }
  assert.deepEqual(fields.envelope, ENVELOPE);
  for (const type of Object.keys(ALLOWED)) {
    assert.deepEqual(fields[type], ALLOWED[type], `fields of ${type}`);
  }
});

test('every field in docs/design/event_schema_v0.1.md has one of the six privacy classes', () => {
  const doc = readFileSync(new URL('../../docs/design/event_schema_v0.1.md', import.meta.url), 'utf8');
  const classes = [...doc.matchAll(/^- \*\*(\w+)\*\*:/gm)].map((m) => m[1]);
  assert.deepEqual(classes, ['content', 'identity', 'timing', 'rate', 'structural', 'inference']);
  const byField = {};
  let section = null;
  for (const line of doc.split('\n')) {
    const h = line.match(/^##+ (?:`(\w+)`|Envelope)/);
    if (h) { section = h[1] ?? 'envelope'; continue; }
    const row = line.match(/^\| `(\w+)` \|/);
    if (row && section) byField[`${section}.${row[1]}`] = line.split('|')[5].trim();
  }
  for (const [field, cls] of Object.entries(byField)) assert.ok(classes.includes(cls), `${field}: ${cls}`);
  const inference = Object.keys(byField).filter((f) => byField[f] === 'inference');
  assert.deepEqual(inference, ['state.state', 'state.confidence']);
});

test('session: a new session gets a random id and is saved for this tab', () => {
  const store = fakeStorage();
  const s = resumeOrStartSession(store, { participantId: 'T-ABCDEFGH', newId: () => 'id-1' });
  assert.deepEqual([s.session_id, s.resumed, s.next_seq, s.error], ['id-1', false, 0, null]);
  assert.deepEqual(JSON.parse(store.getItem('c1.session')), { session_id: 'id-1', participant_id: 'T-ABCDEFGH', next_seq: 0 });
});

test('session: a reload in the same tab continues the session and its seq', () => {
  const store = fakeStorage();
  saveSession(store, { session_id: 'id-1', participant_id: 'T-ABCDEFGH', next_seq: 57 });
  const s = resumeOrStartSession(store, { participantId: 'T-ABCDEFGH', newId: () => 'id-2' });
  assert.deepEqual([s.session_id, s.resumed, s.next_seq], ['id-1', true, 57]);
  endSession(store);
  assert.equal(resumeOrStartSession(store, { participantId: 'T-ABCDEFGH', newId: () => 'id-2' }).session_id, 'id-2');
});

test('session: unreadable or unusable storage starts a new session and explains why', () => {
  const corrupt = fakeStorage();
  corrupt.setItem('c1.session', '{not json');
  const a = resumeOrStartSession(corrupt, { participantId: 'P', newId: () => 'id-3' });
  assert.deepEqual([a.session_id, a.resumed], ['id-3', false]);
  assert.match(a.error, /could not be read/);
  const broken = { getItem() { throw new DOMException('denied', 'SecurityError'); }, setItem() { throw new DOMException('denied', 'SecurityError'); } };
  const b = resumeOrStartSession(broken, { participantId: 'P', newId: () => 'id-4' });
  assert.deepEqual([b.session_id, b.resumed], ['id-4', false]);
  assert.match(b.error, /could not be saved \(SecurityError\)/);
});

test('stash: records kept during pagehide come back in order, once', () => {
  const store = fakeStorage();
  assert.equal(stashRecord(store, { seq: 31 }), null);
  assert.equal(stashRecord(store, { seq: 32 }), null);
  assert.deepEqual(takeStash(store).map((r) => r.seq), [31, 32]);
  assert.deepEqual(takeStash(store), []);
});

test('stash: unusable or corrupt storage is reported, never thrown', () => {
  const broken = { getItem() { throw new DOMException('denied', 'SecurityError'); } };
  assert.match(stashRecord(broken, { seq: 1 }), /could not be kept for the reload \(SecurityError\)/);
  const corrupt = fakeStorage();
  corrupt.setItem('c1.pending', '{not json');
  assert.deepEqual(takeStash(corrupt), []);
  assert.deepEqual(takeStash(null), []);
});

test('session: the default id is a random version 4 UUID', () => {
  const s = resumeOrStartSession(fakeStorage(), { participantId: 'P' });
  assert.match(s.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(s.session_id, resumeOrStartSession(fakeStorage(), { participantId: 'P' }).session_id);
  assert.equal(SCHEMA_VERSION, '0.1');
});

// An in-memory stand-in for sessionStorage.
function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}
