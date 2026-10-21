// Tests for src/timing.js (run from capture_client/ with npm test).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { timed, takeSpent, setClock } from '../src/timing.js';

function steppingClock(step) {
  let c = 0;
  return () => (c += step);
}

afterEach(() => {
  setClock(() => performance.now());
  takeSpent();
});

test('the default clock is performance.now()', async (t) => {
  const fresh = await import('../src/timing.js?default-clock');
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  fresh.timed(() => { now += 2.5; })();
  assert.equal(fresh.takeSpent(), 2.5);
});

test('only the time inside each call counts, not the time between calls', () => {
  let now = 100;
  setClock(() => now);
  timed(() => { now += 3; })();
  now += 50;
  timed(() => { now += 0.5; })();
  assert.equal(takeSpent(), 3.5);
});

test('timed passes the arguments and the result through, and adds the run time', () => {
  setClock(steppingClock(0.25));
  const add = timed((a, b) => a + b);
  assert.equal(add(2, 3), 5);
  assert.equal(add(4, 5), 9);
  assert.equal(takeSpent(), 0.5);
  assert.equal(takeSpent(), 0);
});

test('a call that throws still counts', () => {
  setClock(steppingClock(0.25));
  const broken = timed(() => { throw new Error('boom'); });
  assert.throws(broken, /boom/);
  assert.equal(takeSpent(), 0.25);
});

test('takeSpent rounds to the nearest 0.001 ms', () => {
  let now = 0;
  setClock(() => now);
  timed(() => { now += 0.0014; })();
  assert.equal(takeSpent(), 0.001);
  timed(() => { now += 0.0016; })();
  assert.equal(takeSpent(), 0.002);
  setClock(steppingClock(0.1));
  const f = timed(() => {});
  f();
  f();
  f();
  assert.equal(takeSpent(), 0.3);
});
