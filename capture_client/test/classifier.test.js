// Tests for src/classifier.js (run from capture_client/ with npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClassifier } from '../src/classifier.js';
import { computeWindowFeatures } from '../src/features.js';
import { loadModel, predict, MODEL_FEATURES } from '../src/model.js';

const MODEL = loadModel({
  model_version: 'test-1', window_ms: 30000, classes: ['absent', 'present'],
  features: ['visible_fraction', 'pointer_per_s'], mean: [0, 1], scale: [1, 1], coef: [0, 10], intercept: 0,
});
const tick = (t, pointer = 0, bucket_ms = 1000) => ({
  t, bucket_ms, pointer_count: pointer, pointer_slots: Math.min(pointer, 4), touch_count: 0, touch_slots: 0,
  key_count: 0, key_slots: 0, proc_ms: 0.1,
});
const startEvents = (t) => [{ type: 'start', t }, { type: 'visibility', state: 'visible', t, initial: true },
  { type: 'focus', state: 'focus', t, initial: true }];

// A classifier whose clock reads each row's time plus lag; feed() takes records and rows in time order.
function setup({ lag = 2, hopMs = 5000, start = 0, model = MODEL } = {}) {
  const out = [];
  const clock = { t: 0 };
  const c = createClassifier({ model, hopMs, now: () => clock.t, emit: (s) => out.push(s) });
  for (const e of startEvents(start)) c.noteEvent(e);
  const feed = (items) => {
    for (const r of items) {
      if (r.type) { c.noteEvent(r); continue; }
      clock.t = r.t + lag;
      c.noteRow(r);
    }
  };
  return { c, out, feed, clock };
}
function run(rows, options) {
  const { out, feed } = setup(options);
  feed(rows);
  return out;
}
const seconds = (from, to, pointer = 0) => Array.from({ length: to - from }, (_, i) => tick((from + i + 1) * 1000, pointer));

test('the first window closes at the first row at or after start + 30 s', () => {
  const states = run(seconds(0, 31, 3));
  assert.deepEqual(states.map((s) => s.window_end), [30000]);
  assert.equal(states[0].latency_ms, 2);
  assert.equal(states[0].compute_ms, 0);
  assert.equal(states[0].state, 'present');
  assert.equal(states[0].window_ms, 30000);
  assert.equal(states[0].model_version, 'test-1');
});

test('a state every 5 s after the first; 100 windows need 30 + 99 x 5 = 525 s', () => {
  const states = run(seconds(0, 525, 3));
  assert.equal(states.length, 100);
  assert.deepEqual(states.slice(0, 3).map((s) => s.window_end), [30000, 35000, 40000]);
  assert.equal(states.at(-1).window_end, 525000);
});

test('a late row closes every window it passes, each with its own latency', () => {
  const rows = [...seconds(0, 29, 3), tick(47500, 3, 18500)];
  const states = run(rows, { lag: 0 });
  assert.deepEqual(states.map((s) => s.window_end), [30000, 35000, 40000, 45000]);
  assert.deepEqual(states.map((s) => s.latency_ms), [17500, 12500, 7500, 2500]);
});

test('after a visibility change the 1 s timer restarts, so a window can wait for most of a tick', () => {
  const rows = [...seconds(0, 28, 3), tick(28400, 3, 400), tick(28700, 0, 300),
    tick(29700, 3), tick(30700, 3), tick(31700, 3)];
  const states = run(rows, { lag: 0 });
  assert.deepEqual(states.map((s) => [s.window_end, s.latency_ms]), [[30000, 700]]);
});

test('one late row closing several windows: each compute_ms counts only its own window', () => {
  const out = [];
  const clock = { t: 0 };
  const c = createClassifier({ model: MODEL, now: () => clock.t, emit: (s) => { out.push(s); clock.t += 7; } });
  for (const e of startEvents(0)) c.noteEvent(e);
  for (const r of seconds(0, 29, 3)) { clock.t = r.t; c.noteRow(r); }
  clock.t = 47500;
  c.noteRow(tick(47500, 3, 18500));
  assert.deepEqual(out.map((s) => s.compute_ms), [0, 0, 0, 0]);
  assert.deepEqual(out.map((s) => s.latency_ms), [17500, 12507, 7514, 2521]);
});

test('windows that ended while the page was frozen (back/forward cache) are skipped and counted', () => {
  const { c, out, feed } = setup();
  feed([...seconds(0, 40, 3),
    { type: 'pagehide', t: 40500, persisted: true }, tick(40500, 3, 500),
    { type: 'visibility', state: 'visible', t: 100000, initial: true },
    { type: 'focus', state: 'focus', t: 100000, initial: true },
    ...seconds(100, 140, 3)]);
  const want = [30000, 35000, 40000, ...Array.from({ length: 8 }, (_, i) => 105000 + i * 5000)];
  assert.deepEqual(out.map((s) => s.window_end), want);
  assert.equal(c.skipped, 12);
  assert.ok(out.every((s) => s.latency_ms === 2));
  assert.equal(out[3].state, 'present');
});

test('compute_ms is the time for the features and the model; latency adds the wait before them', () => {
  let reads = 0;
  const { out, feed, clock } = setup({ lag: 2 });
  const slow = { type: 'visibility', t: 10000, get state() { reads += 1; clock.t += 1; return 'visible'; } };
  feed([...seconds(0, 10, 3), slow, ...seconds(10, 30, 3)]);
  assert.equal(out.length, 1);
  assert.ok(reads > 0);
  assert.equal(out[0].compute_ms, reads);
  assert.equal(out[0].latency_ms, 2 + reads);
  assert.equal(out[0].t, 30002 + reads);
});

test('the state equals the model on features.js over all events (pruning changes nothing)', () => {
  const n = MODEL_FEATURES.length;
  const model = loadModel({ model_version: 'all-10', window_ms: 30000, classes: ['absent', 'present'],
    features: [...MODEL_FEATURES], mean: Array(n).fill(0.5), scale: Array(n).fill(2),
    coef: MODEL_FEATURES.map((_, i) => (i % 2 ? 0.3 : -0.2)), intercept: 0.1 });
  const pointer = (s) => (s % 7 === 0 ? 0 : s % 4);
  const rows = Array.from({ length: 200 }, (_, i) => ({ ...tick((i + 1) * 1000, pointer(i + 1)),
    key_count: i % 5, key_slots: Math.min(i % 5, 4) }));
  const changes = [{ type: 'visibility', state: 'hidden', t: 42500 }, { type: 'visibility', state: 'visible', t: 61250 },
    { type: 'focus', state: 'blur', t: 90100 }, { type: 'focus', state: 'focus', t: 130700 }];
  const items = [...rows, ...changes].sort((a, b) => a.t - b.t);
  const { c, out, feed } = setup({ model });
  feed(items);
  const all = [...startEvents(0), ...changes, ...rows.map((r) => ({ type: 'tick', ...r }))];
  assert.equal(out.length, 35);
  for (const s of out) {
    const want = predict(model, computeWindowFeatures(all, s.window_end - 30000, 30000));
    assert.equal(s.state, want.state);
    assert.equal(s.confidence, want.confidence);
  }
  const f = computeWindowFeatures(all, 40000, 30000);
  assert.equal(f.visibility_changes, 2);
  assert.equal(c.keptTicks, 25);
});

test('no start, no windows; an unknown feature gives a null state', () => {
  const out = [];
  const c = createClassifier({ model: MODEL, now: () => 0, emit: (s) => out.push(s) });
  for (const r of seconds(0, 40)) c.noteRow(r);
  assert.equal(out.length, 0);
  const states = [];
  const c2 = createClassifier({ model: MODEL, now: () => 0, emit: (s) => states.push(s) });
  c2.noteEvent({ type: 'start', t: 0 });
  for (const r of seconds(0, 30)) c2.noteRow(r);
  assert.deepEqual([states[0].state, states[0].confidence], [null, null]);
});

test('a second start (another page) does not move the grid; a bad hop is refused', () => {
  const out = [];
  const c = createClassifier({ model: MODEL, now: () => 0, emit: (s) => out.push(s) });
  c.noteEvent({ type: 'start', t: 100 });
  c.noteEvent({ type: 'start', t: 9000 });
  assert.equal(c.nextEnd, 30100);
  assert.throws(() => createClassifier({ model: MODEL, hopMs: 0, now: () => 0, emit: () => {} }), /hopMs/);
});
