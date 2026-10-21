// Tests for src/activity.js (run from capture_client/ with npm test).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { start, stop, getRows } from '../src/activity.js';
import { setClock, takeSpent } from '../src/timing.js';

const TYPES = ['pointermove', 'touchmove', 'keydown'];

// An EventTarget that remembers the options each listener was added with.
class RecordingTarget extends EventTarget {
  options = [];
  addEventListener(name, handler, opts) { this.options.push(opts); super.addEventListener(name, handler, opts); }
}

const PRIVATE = ['key', 'code', 'keyCode', 'which', 'charCode', 'clientX', 'clientY', 'screenX', 'screenY',
  'pageX', 'pageY', 'offsetX', 'offsetY', 'movementX', 'movementY', 'touches', 'changedTouches', 'targetTouches'];

// An event whose private fields record any attempt to read them.
function makeEvent(type, allowed = {}, secrets = {}, reads = null) {
  const e = new Event(type);
  for (const [k, v] of Object.entries(allowed)) Object.defineProperty(e, k, { value: v });
  if (reads) {
    for (const name of PRIVATE) {
      Object.defineProperty(e, name, { get() { reads.add(name); return secrets[name]; } });
    }
  }
  return e;
}

function fakeEnv() {
  const doc = new RecordingTarget();
  const win = new EventTarget();
  const clock = { t: 0 };
  const timers = [];
  const every = (ms, fn) => {
    const timer = { fn, ms, cancelled: false };
    timers.push(timer);
    return () => { timer.cancelled = true; };
  };
  return { doc, win, clock, timers, now: () => clock.t, every };
}

function fire(env, t, type, allowed, secrets, reads) {
  env.clock.t = t;
  env.doc.dispatchEvent(makeEvent(type, allowed, secrets, reads));
}

// Closes the open bucket at time t, as the 1 s timer would.
function tick(env, t) {
  env.clock.t = t;
  env.timers.filter((x) => !x.cancelled).at(-1).fn();
}

function vis(env, t, state) {
  env.clock.t = t;
  Object.defineProperty(env.doc, 'visibilityState', { value: state, configurable: true });
  env.doc.dispatchEvent(new Event('visibilitychange'));
}

function page(env, t, type, persisted) {
  env.clock.t = t;
  env.win.dispatchEvent(Object.assign(new Event(type), { persisted }));
}

const attached = (doc) => TYPES.map((name) => getEventListeners(doc, name).length);
const mouse = { pointerType: 'mouse' };
const press = { repeat: false };

const stillClock = () => 0;
// A clock that moves by step at every read.
function steppingClock(step) {
  let c = 0;
  return () => (c += step);
}
setClock(stillClock);
afterEach(() => {
  stop();
  setClock(stillClock);
  takeSpent();
});

test('one row per 1 s bucket, with counts and active slots per kind', () => {
  const env = fakeEnv();
  start(env);
  assert.equal(env.timers[0].ms, 1000);
  fire(env, 10, 'pointermove', mouse);
  fire(env, 20, 'pointermove', mouse);
  fire(env, 30, 'pointermove', mouse);
  fire(env, 100, 'keydown', press);
  fire(env, 260, 'pointermove', mouse);
  fire(env, 600, 'keydown', press);
  fire(env, 900, 'pointermove', mouse);
  tick(env, 1000);
  assert.deepEqual(getRows(), [{
    t: 1000, bucket_ms: 1000,
    pointer_count: 5, pointer_slots: 3,
    touch_count: 0, touch_slots: 0,
    key_count: 2, key_slots: 2,
    proc_ms: 0,
  }]);
});

test('slot boundaries: floor((t - bucket start) / 250)', () => {
  const env = fakeEnv();
  start(env);
  for (const t of [0, 124, 126, 249.9]) fire(env, t, 'pointermove', mouse);
  tick(env, 1000);
  assert.equal(getRows()[0].pointer_slots, 1);
  for (const t of [1000, 1124, 1126, 1249.9, 1250]) fire(env, t, 'pointermove', mouse);
  tick(env, 2000);
  assert.equal(getRows()[1].pointer_slots, 2);
});

test('touch is counted once, by the touch counter', () => {
  const env = fakeEnv();
  start(env);
  for (let i = 0; i < 3; i++) fire(env, 50, 'pointermove', { pointerType: 'touch' });
  fire(env, 50, 'touchmove');
  fire(env, 80, 'pointermove', { pointerType: 'pen' });
  fire(env, 700, 'touchmove');
  tick(env, 1000);
  const [row] = getRows();
  assert.deepEqual([row.touch_count, row.touch_slots], [2, 2]);
  assert.equal(row.pointer_count, 1);
});

test('held-down key repeats add neither count nor slots', () => {
  const env = fakeEnv();
  start(env);
  fire(env, 10, 'keydown', press);
  for (const t of [510, 543, 576, 760]) fire(env, t, 'keydown', { repeat: true });
  tick(env, 1000);
  assert.deepEqual([getRows()[0].key_count, getRows()[0].key_slots], [1, 1]);
});

test('an event without pointerType or repeat still counts', () => {
  const env = fakeEnv();
  start(env);
  fire(env, 100, 'pointermove');
  fire(env, 200, 'keydown');
  tick(env, 1000);
  assert.deepEqual([getRows()[0].pointer_count, getRows()[0].key_count], [1, 1]);
});

test('each bucket starts from zero', () => {
  const env = fakeEnv();
  start(env);
  fire(env, 100, 'pointermove', mouse);
  tick(env, 1000);
  fire(env, 1300, 'pointermove', mouse);
  tick(env, 2000);
  const row = getRows()[1];
  assert.deepEqual([row.bucket_ms, row.pointer_count, row.pointer_slots], [1000, 1, 1]);
});

test('slots are measured from the bucket start, not the session start', () => {
  const env = fakeEnv();
  start(env);
  tick(env, 1925.7);
  fire(env, 2100, 'pointermove', mouse);
  fire(env, 2200, 'pointermove', mouse);
  tick(env, 2925.7);
  const row = getRows()[1];
  assert.equal(row.pointer_slots, 2);
  assert.ok(Math.abs(row.bucket_ms - 1000) < 1e-9);
});

test('a timer that fires a little late never makes a 5th slot', () => {
  const env = fakeEnv();
  start(env);
  fire(env, 100, 'pointermove', mouse);
  fire(env, 1000.8, 'pointermove', mouse);
  tick(env, 1001.5);
  assert.deepEqual([getRows()[0].pointer_count, getRows()[0].pointer_slots], [2, 2]);
  fire(env, 1901.5, 'pointermove', mouse);
  fire(env, 2001.5, 'pointermove', mouse);
  tick(env, 2001.5);
  assert.equal(getRows()[1].pointer_slots, 1);
});

test('a long hidden-tab bucket keeps its real length and slots', () => {
  const env = fakeEnv();
  start(env);
  fire(env, 100, 'pointermove', mouse);
  fire(env, 1800, 'pointermove', mouse);
  tick(env, 1925.7);
  const [row] = getRows();
  assert.deepEqual([row.bucket_ms, row.pointer_slots], [1925.7, 2]);
});

test('listeners use the capture phase and are passive', () => {
  const env = fakeEnv();
  start(env);
  assert.deepEqual(env.doc.options, [
    { capture: true, passive: true }, { capture: true, passive: true }, { capture: true, passive: true },
    { capture: true, passive: true },
  ]);
});

test('stop removes every listener, cancels the timer and keeps the last part', () => {
  const env = fakeEnv();
  start(env);
  assert.deepEqual(attached(env.doc), [1, 1, 1]);
  assert.equal(getEventListeners(env.doc, 'visibilitychange').length, 1);
  fire(env, 300, 'pointermove', mouse);
  env.clock.t = 400;
  stop();
  assert.deepEqual(attached(env.doc), [0, 0, 0]);
  assert.equal(getEventListeners(env.doc, 'visibilitychange').length, 0);
  assert.deepEqual(['pagehide', 'pageshow'].map((n) => getEventListeners(env.win, n).length), [0, 0]);
  assert.equal(env.timers[0].cancelled, true);
  assert.deepEqual([getRows().length, getRows()[0].bucket_ms, getRows()[0].pointer_count], [1, 400, 1]);
  start(env);
  fire(env, 500, 'pointermove', mouse);
  tick(env, 1400);
  assert.equal(getRows()[0].pointer_count, 1);
});

test('stop never writes a zero-length row', () => {
  const env = fakeEnv();
  start(env);
  stop();
  assert.equal(getRows().length, 0);
  start(env);
  tick(env, 1000);
  stop();
  assert.equal(getRows().length, 1);
});

test('start twice: one set of listeners, one live timer, rows wiped', () => {
  const env = fakeEnv();
  start(env);
  fire(env, 100, 'pointermove', mouse);
  tick(env, 1000);
  start(env);
  assert.deepEqual(attached(env.doc), [1, 1, 1]);
  assert.equal(getEventListeners(env.doc, 'visibilitychange').length, 1);
  assert.equal(env.timers.filter((x) => !x.cancelled).length, 1);
  assert.equal(getRows().length, 0);
});

test('privacy: no private field is read, and a typed sentence never reaches the rows', () => {
  const env = fakeEnv();
  start(env);
  const reads = new Set();
  const sentence = 'Purple elephants quietly juggle seventeen mangoes';
  [...sentence].forEach((ch, i) =>
    fire(env, 10 + i * 15, 'keydown', press, { key: ch, code: `Key${ch.toUpperCase()}` }, reads));
  fire(env, 900, 'pointermove', mouse, { clientX: 123.456, clientY: 654.321, screenX: 777, pageY: 888 }, reads);
  fire(env, 950, 'touchmove', {}, { touches: [{ clientX: 123.456 }] }, reads);
  tick(env, 1000);
  assert.deepEqual([...reads], []);
  const json = JSON.stringify(getRows()).toLowerCase();
  for (const word of sentence.toLowerCase().split(' ')) assert.equal(json.includes(word), false, word);
  for (const v of ['123.456', '654.321', '777', '888']) assert.equal(json.includes(v), false, v);
  assert.deepEqual(Object.keys(getRows()[0]).sort(), [
    'bucket_ms', 'key_count', 'key_slots', 'pointer_count', 'pointer_slots', 'proc_ms', 't', 'touch_count', 'touch_slots',
  ]);
  assert.equal(sentence.length, 49);
  assert.equal(getRows()[0].key_count, 49);
});

test('onRow receives a copy of every new row, including the last part at stop', () => {
  const env = fakeEnv();
  const got = [];
  start(env, { onRow: (r) => got.push(r) });
  fire(env, 100, 'pointermove', mouse);
  tick(env, 1000);
  env.clock.t = 1500;
  stop();
  assert.deepEqual(got.map((r) => r.bucket_ms), [1000, 500]);
  got[0].pointer_count = 99;
  assert.equal(getRows()[0].pointer_count, 1);
});

test('pagehide saves the open part-second and capture goes on', () => {
  const env = fakeEnv();
  start(env);
  fire(env, 100, 'pointermove', mouse);
  tick(env, 1000);
  fire(env, 1200, 'pointermove', mouse);
  fire(env, 1300, 'keydown', press);
  env.clock.t = 1450;
  env.win.dispatchEvent(new Event('pagehide'));
  const flushed = getRows()[1];
  assert.deepEqual([getRows().length, flushed.bucket_ms, flushed.pointer_count, flushed.key_count], [2, 450, 1, 1]);
  fire(env, 1500, 'pointermove', mouse);
  tick(env, 2450);
  assert.deepEqual([getRows()[2].bucket_ms, getRows()[2].pointer_count], [1000, 1]);
});

test('pagehide right after a tick writes no zero-length row', () => {
  const env = fakeEnv();
  start(env);
  tick(env, 1000);
  env.win.dispatchEvent(new Event('pagehide'));
  assert.equal(getRows().length, 1);
});

test('back from the back/forward cache: the frozen time is not counted as a quiet second', () => {
  const env = fakeEnv();
  start(env);
  env.clock.t = 500;
  env.win.dispatchEvent(new Event('pagehide'));
  env.clock.t = 60000;
  env.win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  fire(env, 60100, 'pointermove', mouse);
  tick(env, 61000);
  assert.deepEqual(getRows().map((r) => r.bucket_ms), [500, 1000]);
  env.clock.t = 61200;
  env.win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
  tick(env, 62000);
  assert.equal(getRows()[2].bucket_ms, 1000);
});

test('a visibility change ends the bucket and restarts the 1 s timer (D028)', () => {
  const env = fakeEnv();
  start(env);
  fire(env, 100, 'pointermove', mouse);
  fire(env, 300, 'pointermove', mouse);
  vis(env, 400, 'hidden');
  const first = getRows()[0];
  assert.deepEqual([first.t, first.bucket_ms, first.pointer_count, first.pointer_slots], [400, 400, 2, 2]);
  const live = env.timers.filter((x) => !x.cancelled);
  assert.deepEqual([env.timers.length, live.length, live[0].ms], [2, 1, 1000]);
  tick(env, 1400);
  vis(env, 1650, 'visible');
  fire(env, 1700, 'pointermove', mouse);
  tick(env, 2650);
  assert.deepEqual(getRows().map((r) => r.bucket_ms), [400, 1000, 250, 1000]);
  assert.deepEqual([getRows()[3].pointer_count, getRows()[3].pointer_slots], [1, 1]);
});

test('the switch-tab run of 16 Oct 2026, rounded to 1 ms: no mixed bucket and no sliver', () => {
  const env = fakeEnv();
  start(env);
  const first = env.timers[0];
  tick(env, 1001);
  tick(env, 2002);
  vis(env, 2421, 'hidden');
  vis(env, 3895, 'visible');
  assert.deepEqual([env.timers.length, env.timers.filter((x) => !x.cancelled).length], [3, 1]);
  if (!first.cancelled) { env.clock.t = 3895.3; first.fn(); }
  tick(env, 4895);
  assert.deepEqual(getRows().map((r) => r.bucket_ms), [1001, 1001, 419, 1474, 1000]);
});

test('a visibility change right after a tick writes no zero-length row', () => {
  const env = fakeEnv();
  start(env);
  tick(env, 1000);
  vis(env, 1000, 'hidden');
  assert.equal(getRows().length, 1);
  assert.deepEqual([env.timers.length, env.timers.filter((x) => !x.cancelled).length], [2, 1]);
});

test('stop after a visibility change cancels the restarted timer', () => {
  const env = fakeEnv();
  start(env);
  vis(env, 500, 'hidden');
  env.clock.t = 700;
  stop();
  assert.equal(env.timers.every((x) => x.cancelled), true);
  assert.deepEqual(getRows().map((r) => r.bucket_ms), [500, 200]);
  vis(env, 900, 'visible');
  assert.deepEqual([getRows().length, env.timers.length], [2, 2]);
});

test('the restarted timer keeps the bucket length set at start', () => {
  const env = fakeEnv();
  start(env, { bucketMs: 2000 });
  vis(env, 500, 'hidden');
  const live = env.timers.filter((x) => !x.cancelled);
  assert.deepEqual([live.length, live[0].ms], [1, 2000]);
  tick(env, 2500);
  assert.deepEqual(getRows().map((r) => r.bucket_ms), [500, 2000]);
});

test('a reload: the change to hidden after pagehide writes no extra row', () => {
  const env = fakeEnv();
  start(env);
  tick(env, 1000);
  page(env, 1450, 'pagehide', false);
  vis(env, 1451, 'hidden');
  assert.deepEqual(getRows().map((r) => r.bucket_ms), [1000, 450]);
  assert.equal(env.timers.length, 1);
});

test('back/forward cache, visible before pageshow: no row covers the time in the cache', () => {
  const env = fakeEnv();
  start(env);
  tick(env, 1000);
  page(env, 1500, 'pagehide', true);
  vis(env, 1501, 'hidden');
  vis(env, 61500, 'visible');
  page(env, 61501, 'pageshow', true);
  tick(env, 62501);
  assert.deepEqual(getRows().map((r) => r.bucket_ms), [1000, 500, 1000]);
  vis(env, 62801, 'hidden');
  assert.equal(getRows().at(-1).bucket_ms, 300);
  assert.deepEqual([env.timers.length, env.timers.filter((x) => !x.cancelled).length], [3, 1]);
});

test('into the back/forward cache, an old timer that fires before pageshow writes no row (D043)', () => {
  const env = fakeEnv();
  start(env);
  tick(env, 1000);
  page(env, 1500, 'pagehide', true);
  tick(env, 61000);
  page(env, 61001, 'pageshow', true);
  tick(env, 62001);
  assert.deepEqual(getRows().map((r) => r.bucket_ms), [1000, 500, 1000]);
  const env2 = fakeEnv();
  start(env2);
  page(env2, 400, 'pagehide', false);
  tick(env2, 1400);
  assert.deepEqual(getRows().map((r) => r.bucket_ms), [400, 1000]);
});

test('a new start clears the going-away state', () => {
  const env = fakeEnv();
  start(env);
  page(env, 500, 'pagehide', false);
  env.clock.t = 600;
  stop();
  start(env);
  vis(env, 900, 'hidden');
  assert.deepEqual(getRows().map((r) => r.bucket_ms), [300]);
});

test('proc_ms: the client work since the previous row, each ms counted once (D029)', () => {
  setClock(steppingClock(0.25));
  const env = fakeEnv();
  start(env);
  fire(env, 100, 'pointermove', mouse);
  fire(env, 200, 'pointermove', mouse);
  fire(env, 300, 'pointermove', mouse);
  fire(env, 400, 'keydown', press);
  tick(env, 1000);
  assert.equal(getRows()[0].proc_ms, 1);
  fire(env, 1500, 'pointermove', mouse);
  tick(env, 2000);
  assert.equal(getRows()[1].proc_ms, 0.5);
});

test('proc_ms counts the pagehide and visibility handlers, but not stop()', () => {
  setClock(steppingClock(0.25));
  const env = fakeEnv();
  start(env);
  fire(env, 100, 'pointermove', mouse);
  vis(env, 300, 'hidden');
  assert.equal(getRows()[0].proc_ms, 0.25);
  page(env, 500, 'pagehide', false);
  assert.equal(getRows()[1].proc_ms, 0.25);
  fire(env, 600, 'pointermove', mouse);
  env.clock.t = 700;
  stop();
  assert.equal(getRows()[2].proc_ms, 0.5);
  assert.equal(takeSpent(), 0);
});

test('the row copy sent to onRow (the export path) carries proc_ms', () => {
  setClock(steppingClock(0.25));
  const env = fakeEnv();
  const got = [];
  start(env, { onRow: (r) => got.push(r) });
  fire(env, 100, 'pointermove', mouse);
  tick(env, 1000);
  assert.equal(got[0].proc_ms, 0.25);
});

test('getRows returns copies', () => {
  const env = fakeEnv();
  start(env);
  tick(env, 1000);
  getRows()[0].key_count = 99;
  assert.equal(getRows()[0].key_count, 0);
});
