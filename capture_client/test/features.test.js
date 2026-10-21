// Tests for src/features.js (run from capture_client/ with npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeWindowFeatures } from '../src/features.js';

// The three records written at start.
const startAt = (t, visibility = 'visible', focus = 'focus') => [
  { type: 'start', t, wall_ms: 1791800000000 },
  { type: 'visibility', state: visibility, t, initial: true },
  { type: 'focus', state: focus, t, initial: true },
];
const vis = (t, state) => ({ type: 'visibility', state, t });
const foc = (t, state) => ({ type: 'focus', state, t });

const tick = (t, fields = {}, bucket_ms = 1000) => ({
  type: 'tick', t, bucket_ms,
  pointer_count: 0, pointer_slots: 0, touch_count: 0, touch_slots: 0, key_count: 0, key_slots: 0,
  ...fields,
});

const near = (a, b) => Math.abs(a - b) < 1e-9;

test('normal: a quiet window that is visible and focused all the time', () => {
  const f = computeWindowFeatures(startAt(0), 2000, 3000);
  assert.deepEqual(
    [f.state_known_ms, f.visible_fraction, f.focused_fraction, f.visibility_changes, f.focus_changes],
    [3000, 1, 1, 0, 0],
  );
});

test('normal: visible and focused fractions and change counts', () => {
  const events = [...startAt(0), foc(2500, 'blur'), vis(2501, 'hidden'), vis(4000, 'visible'), foc(4100, 'focus')];
  const f = computeWindowFeatures(events, 2000, 4000);
  assert.ok(near(f.visible_fraction, 0.62525));
  assert.ok(near(f.focused_fraction, 0.6));
  assert.deepEqual([f.visibility_changes, f.focus_changes], [2, 2]);
});

test('normal: activity rates from whole buckets', () => {
  const events = [
    ...startAt(0),
    tick(3000, { pointer_count: 30, pointer_slots: 4, key_count: 3, key_slots: 3 }),
    tick(4000, { pointer_count: 12, pointer_slots: 2 }),
    tick(5000),
  ];
  const f = computeWindowFeatures(events, 2000, 3000);
  assert.deepEqual(
    [f.activity_known_ms, f.pointer_per_s, f.pointer_slots_per_s, f.key_per_s, f.key_slots_per_s, f.touch_per_s, f.touch_slots_per_s],
    [3000, 14, 2, 1, 1, 0, 0],
  );
});

test('normal: a bucket only partly inside the window counts in proportion', () => {
  const events = [tick(3000, { pointer_count: 40 }), tick(4000, { pointer_count: 20 })];
  const f = computeWindowFeatures(events, 2500, 1000);
  assert.deepEqual([f.activity_known_ms, f.pointer_per_s], [1000, 30]);
});

test('normal: rates use only the time covered by tick rows', () => {
  const f = computeWindowFeatures([tick(2000, { pointer_count: 10 })], 0, 3000);
  assert.deepEqual([f.activity_known_ms, f.pointer_per_s], [1000, 10]);
});

test('normal: a long hidden-tab bucket is divided by its real length', () => {
  const f = computeWindowFeatures([tick(6925.7, { pointer_count: 2 }, 1925.7)], 5000, 1925.7);
  assert.ok(near(f.activity_known_ms, 1925.7));
  assert.ok(near(f.pointer_per_s, 2 / 1.9257));
});

test('normal: time since the last input looks back before the window', () => {
  const events = [tick(1000, { key_count: 1 }), tick(2000), tick(3000), tick(4000, { pointer_count: 5 })];
  const f = computeWindowFeatures(events, 2500, 1000);
  assert.equal(f.ms_since_input, 2500);
});

test('normal: time before capture started is not counted', () => {
  const f = computeWindowFeatures(startAt(500), 0, 1000);
  assert.deepEqual([f.state_known_ms, f.visible_fraction, f.activity_known_ms, f.pointer_per_s], [500, 1, 0, null]);
  assert.deepEqual([f.visibility_changes, f.focus_changes], [0, 0]);
});

test('normal: time after stop is not counted', () => {
  const events = [...startAt(0), vis(2500, 'hidden'), { type: 'stop', t: 3000 }];
  const f = computeWindowFeatures(events, 2000, 2000);
  assert.deepEqual([f.state_known_ms, f.visible_fraction, f.focused_fraction], [1000, 0.5, 1]);
});

test('normal: pure, order-free, and unknown record types are ignored', () => {
  const events = [
    ...startAt(0), foc(1200, 'blur'),
    { type: 'probe_result', t: 1300, outcome: 'correct' },
    tick(1000, { key_count: 2 }), tick(2000, { pointer_count: 5 }),
  ];
  const before = structuredClone(events);
  const a = computeWindowFeatures(events, 0, 2000);
  const b = computeWindowFeatures([...events].reverse(), 0, 2000);
  assert.deepEqual(events, before);
  assert.deepEqual(a, b);
  assert.equal(a.focused_fraction, 0.6);
});

test('edge, empty: no records at all', () => {
  const f = computeWindowFeatures([], 0, 1000);
  assert.deepEqual(
    [f.state_known_ms, f.visible_fraction, f.focused_fraction, f.visibility_changes, f.focus_changes,
      f.activity_known_ms, f.pointer_per_s, f.ms_since_input],
    [0, null, null, 0, 0, 0, null, null],
  );
});

test('edge, empty: no records inside the window, state carried in from before', () => {
  const events = [...startAt(0), vis(500, 'hidden')];
  const f = computeWindowFeatures(events, 1000, 1000);
  assert.deepEqual(
    [f.state_known_ms, f.visible_fraction, f.focused_fraction, f.visibility_changes, f.focus_changes],
    [1000, 0, 1, 0, 0],
  );
});

test('edge, empty: the window length must be a positive number', () => {
  for (const bad of [0, -5, NaN]) assert.throws(() => computeWindowFeatures([], 0, bad), RangeError);
});

test('edge, boundary: a change exactly at the window start counts and applies at once', () => {
  const events = [...startAt(0), vis(1000, 'hidden')];
  const f = computeWindowFeatures(events, 1000, 1000);
  assert.deepEqual([f.visible_fraction, f.visibility_changes], [0, 1]);
});

test('edge, boundary: a change exactly at the window end is outside and has no effect', () => {
  const events = [...startAt(0), vis(2000, 'hidden')];
  const f = computeWindowFeatures(events, 1000, 1000);
  assert.deepEqual([f.visible_fraction, f.visibility_changes], [1, 0]);
});

test('edge, boundary: tick rows that only touch the window add nothing', () => {
  const events = [tick(1000, { pointer_count: 99 }), tick(3000, { pointer_count: 99 })];
  const f = computeWindowFeatures(events, 1000, 1000);
  assert.deepEqual([f.activity_known_ms, f.pointer_per_s], [0, null]);
});

test('edge, boundary: input in a bucket that ends exactly at the window end counts as 0 ms ago', () => {
  const f = computeWindowFeatures([tick(2000, { key_count: 1 })], 1000, 1000);
  assert.equal(f.ms_since_input, 0);
});

test('edge, last ms: a change 1 ms before the end', () => {
  const events = [...startAt(0), vis(9999, 'hidden')];
  const f = computeWindowFeatures(events, 0, 10000);
  assert.ok(near(f.visible_fraction, 0.9999));
  assert.equal(f.visibility_changes, 1);
});

test('edge, last ms: a change 1 microsecond before the end', () => {
  const events = [...startAt(0), foc(9999.999, 'blur')];
  const f = computeWindowFeatures(events, 0, 10000);
  assert.ok(near(f.focused_fraction, 0.9999999));
  assert.equal(f.focus_changes, 1);
});

test('edge, overlap: hidden and blurred overlap, measured independently', () => {
  const events = [...startAt(0), foc(1000, 'blur'), vis(1500, 'hidden'), vis(3000, 'visible'), foc(3500, 'focus')];
  const f = computeWindowFeatures(events, 0, 4000);
  assert.deepEqual(
    [f.visible_fraction, f.focused_fraction, f.visibility_changes, f.focus_changes],
    [0.625, 0.375, 2, 2],
  );
});

test('edge, overlap: the brief hidden-but-focused state (focus returns before visibility)', () => {
  const events = [...startAt(0), foc(1000, 'blur'), vis(1001, 'hidden'), foc(2990, 'focus'), vis(3000, 'visible')];
  const f = computeWindowFeatures(events, 0, 4000);
  assert.ok(near(f.visible_fraction, 0.50025));
  assert.ok(near(f.focused_fraction, 0.5025));
});

test('edge, long: a full 2-hour session window', () => {
  const H2 = 2 * 60 * 60 * 1000;
  const events = [...startAt(0)];
  for (let k = 0; k < 60; k++) events.push(vis(120000 * k + 90000, 'hidden'), vis(120000 * (k + 1), 'visible'));
  for (let s = 1; s <= 7200; s++) events.push(tick(s * 1000, { pointer_count: 3, pointer_slots: 2 }));
  const f = computeWindowFeatures(events, 0, H2);
  assert.equal(f.visible_fraction, 0.75);
  assert.equal(f.visibility_changes, 119);
  assert.deepEqual([f.activity_known_ms, f.pointer_per_s, f.pointer_slots_per_s], [H2, 3, 2]);
});

test('edge, long: a window longer than the data counts only the covered time', () => {
  const events = [...startAt(0), tick(1000, { pointer_count: 4 }), { type: 'stop', t: 1000 }];
  const f = computeWindowFeatures(events, 0, 24 * 60 * 60 * 1000);
  assert.deepEqual([f.state_known_ms, f.visible_fraction, f.activity_known_ms, f.pointer_per_s], [1000, 1, 1000, 4]);
});

test('edge, long: an infinite or non-number window is refused', () => {
  assert.throws(() => computeWindowFeatures(startAt(0), 0, Infinity), RangeError);
  assert.throws(() => computeWindowFeatures(startAt(0), NaN, 1000), RangeError);
  assert.throws(() => computeWindowFeatures(startAt(0), -Infinity, 1000), RangeError);
});

test('edge, clock backwards: records are used in time order, not arrival order', () => {
  const events = [...startAt(0), vis(1000, 'hidden'), vis(3000, 'visible'), vis(2000, 'hidden')];
  const f = computeWindowFeatures(events, 0, 4000);
  assert.deepEqual([f.visible_fraction, f.visibility_changes], [0.5, 2]);
});

test('edge, restart: a new session\'s starting state is not a change', () => {
  const events = [...startAt(0, 'visible'), { type: 'stop', t: 1000 }, ...startAt(2000, 'hidden')];
  const f = computeWindowFeatures(events, 0, 3000);
  assert.deepEqual([f.state_known_ms, f.visible_fraction, f.visibility_changes], [2000, 0.5, 0]);
});

test('edge, pagehide: the time after the page went away is unknown, not hidden', () => {
  const events = [...startAt(0), vis(900, 'hidden'), { type: 'pagehide', t: 1000, persisted: false }, ...startAt(1600)];
  const f = computeWindowFeatures(events, 0, 2000);
  assert.equal(f.state_known_ms, 1400);
  assert.ok(near(f.visible_fraction, 1300 / 1400));
  assert.equal(f.visibility_changes, 1);
});

test('edge, pagehide: back from the cache, the first record after it is not a change', () => {
  const events = [...startAt(0), { type: 'pagehide', t: 1000, persisted: true }, vis(5000, 'visible')];
  const f = computeWindowFeatures(events, 0, 6000);
  assert.deepEqual([f.state_known_ms, f.visible_fraction, f.visibility_changes], [2000, 1, 0]);
});

test('edge, clock backwards: a repeated state is never counted as a change', () => {
  const events = [...startAt(0), foc(1000, 'blur'), foc(1500, 'blur'), foc(2000, 'focus'), foc(2500, 'focus')];
  const f = computeWindowFeatures(events, 0, 3000);
  assert.equal(f.focus_changes, 2);
  assert.ok(near(f.focused_fraction, 2 / 3));
});

test('edge, clock backwards: tick rows with zero or negative length are ignored', () => {
  const events = [
    tick(1000, { pointer_count: 10 }),
    tick(2000, { pointer_count: 50 }, -300),
    tick(2000, { pointer_count: 70 }, 0),
  ];
  const f = computeWindowFeatures(events, 0, 3000);
  assert.deepEqual([f.activity_known_ms, f.pointer_per_s], [1000, 10]);
  assert.ok(Number.isFinite(f.pointer_slots_per_s));
});
