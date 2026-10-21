// Tests for src/scheduler.js (run from capture_client/ with npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DEFAULTS, buildSchedule, checkOptions, itemFor, itemOrder, makeSeed, seedHash } from '../src/scheduler.js';

const SEED = '00000001deadbeef00000000ffffffff';
const MIN = 60 * 1000;

const seedOf = (i) => i.toString(16).padStart(8, '0').repeat(4);

test('the scheduler imports nothing, so it cannot read capture or model data (FR7)', () => {
  const source = readFileSync(new URL('../src/scheduler.js', import.meta.url), 'utf8');
  assert.equal(/^\s*import\s/m.test(source) || /\brequire\(|\bimport\(/.test(source), false);
});

test('defaults: 17 probes in 3 h, none in block 0', () => {
  const s = buildSchedule(SEED);
  assert.equal(s.length, 17);
  assert.deepEqual(s.map((p) => p.block), [...Array(17).keys()].map((i) => i + 1));
});

test('each time lies between block start + G/2 and block end - G/2', () => {
  for (const p of buildSchedule(SEED)) {
    assert.ok(p.offsetMs >= p.block * 10 * MIN + 2.5 * MIN, `block ${p.block}`);
    assert.ok(p.offsetMs < p.block * 10 * MIN + 7.5 * MIN, `block ${p.block}`);
  }
});

test('two fire times are never closer than G = 5 min, over 300 seeds', () => {
  let closest = Infinity;
  for (let i = 0; i < 300; i += 1) {
    const s = buildSchedule(seedOf(i));
    for (let j = 1; j < s.length; j += 1) closest = Math.min(closest, s[j].offsetMs - s[j - 1].offsetMs);
  }
  assert.ok(closest >= DEFAULTS.gapMs, `closest gap ${closest}`);
});

test('the same seed always gives the same schedule; another seed gives another', () => {
  assert.deepEqual(buildSchedule(SEED), buildSchedule(SEED));
  assert.notDeepEqual(buildSchedule(SEED), buildSchedule(seedOf(7)));
});

test('times are spread evenly inside the allowed part of each block', () => {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < 2000; i += 1) {
    for (const p of buildSchedule(seedOf(i))) { sum += p.offsetMs - p.block * 10 * MIN; n += 1; }
  }
  assert.equal(n, 34000);
  assert.ok(Math.abs(sum / n / MIN - 5) < 0.05, `mean ${sum / n / MIN} min`);
});

test('settings that would break the rules are refused', () => {
  assert.doesNotThrow(() => checkOptions(DEFAULTS));
  assert.throws(() => checkOptions({ ...DEFAULTS, pendingMs: 4.9 * MIN }), RangeError);
  assert.throws(() => checkOptions({ ...DEFAULTS, blockMs: 4 * MIN }), RangeError);
  assert.throws(() => checkOptions({ ...DEFAULTS, firstBlock: -1 }), RangeError);
  assert.throws(() => buildSchedule('not-a-seed'), RangeError);
});

test('makeSeed: 32 hex characters from 4 random 32-bit words', () => {
  const seed = makeSeed((a) => { a.set([1, 0xdeadbeef, 0, 0xffffffff]); return a; });
  assert.equal(seed, '00000001deadbeef00000000ffffffff');
  assert.match(makeSeed(), /^[0-9a-f]{32}$/);
});

test('seedHash is the SHA-256 of the seed text', async () => {
  const expected = createHash('sha256').update(SEED).digest('hex');
  assert.equal(await seedHash(SEED), expected);
});

test('itemOrder is a fixed shuffle of 0..n-1 for each segment', () => {
  const order = itemOrder(SEED, 'S1', 5);
  assert.deepEqual([...order].sort(), [0, 1, 2, 3, 4]);
  assert.deepEqual(itemOrder(SEED, 'S1', 5), order);
  assert.deepEqual(itemOrder(SEED, 'S1', 1), [0]);
  assert.deepEqual(itemOrder(SEED, 'S1', 0), []);
  const orders = new Set([...Array(20).keys()].map((i) => itemOrder(SEED, `S${i}`, 5).join()));
  assert.ok(orders.size > 1);
});

test('itemFor: no repeat within a segment, and void when a segment runs out', () => {
  const s = buildSchedule(SEED);
  const items = ['a', 'b', 'c'].map((id) => ({ id }));
  const segmentAt = (ms) => ({ id: `S${Math.floor(ms / (20 * MIN))}`, items });
  const b2 = itemFor(SEED, s, 2, segmentAt);
  const b3 = itemFor(SEED, s, 3, segmentAt);
  assert.equal(b2.segmentId, 'S1');
  assert.equal(b3.segmentId, 'S1');
  assert.notEqual(b2.item.id, b3.item.id);
  const order = itemOrder(SEED, 'S1', 3);
  assert.deepEqual([b2.item.id, b3.item.id], [items[order[0]].id, items[order[1]].id]);
  const one = (ms) => ({ id: `S${Math.floor(ms / (20 * MIN))}`, items: [{ id: 'only' }] });
  assert.equal(itemFor(SEED, s, 2, one).item.id, 'only');
  assert.equal(itemFor(SEED, s, 3, one).item, null);
});

test('two real seeds differ (the chance of a repeat is 2^-128)', () => {
  assert.notEqual(makeSeed(), makeSeed());
});

test('the spread of times inside a block is that of a uniform draw, not only its mean', () => {
  const xs = [];
  for (let i = 0; i < 2000; i += 1) {
    for (const p of buildSchedule(seedOf(i))) xs.push((p.offsetMs - p.block * 10 * MIN) / MIN);
  }
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
  assert.ok(Math.abs(sd - 5 / Math.sqrt(12)) < 0.05, `sd ${sd}`);
  assert.ok(Math.min(...xs) >= 2.5 && Math.max(...xs) < 7.5);
});

test('over 200 seeds, a 3-item segment gets all 3! = 6 orders', () => {
  const orders = new Set();
  for (let i = 0; i < 200; i += 1) orders.add(itemOrder(seedOf(i), 'S1', 3).join());
  assert.equal(orders.size, 6);
});

test('known answers for generator sfc32-v1, so a seed logged today rebuilds the same schedule later', () => {
  const s = buildSchedule(SEED);
  assert.equal(s[0].offsetMs, 1034666.6764235124);
  assert.equal(s[16].offsetMs, 10425848.37153554);
  assert.deepEqual(itemOrder(SEED, 'S1', 5), [4, 3, 0, 2, 1]);
});

test('every option rule is checked', () => {
  assert.throws(() => checkOptions({ ...DEFAULTS, gapMs: 0 }), RangeError);
  assert.throws(() => checkOptions({ ...DEFAULTS, firstBlock: 1.5 }), RangeError);
  assert.throws(() => checkOptions({ ...DEFAULTS, upperMs: 60000 }), RangeError);
  assert.throws(() => checkOptions({ ...DEFAULTS, gapMs: Number.NaN }), RangeError);
});
