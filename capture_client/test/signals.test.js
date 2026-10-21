// Tests for src/signals.js (run from capture_client/ with npm test).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { start, stop, getEvents } from '../src/signals.js';
import { setClock, takeSpent } from '../src/timing.js';
import { computeWindowFeatures } from '../src/features.js';

// An EventTarget that counts added and removed listeners.
class CountingTarget extends EventTarget {
  added = 0;
  removed = 0;
  addEventListener(...args) { this.added++; super.addEventListener(...args); }
  removeEventListener(...args) { this.removed++; super.removeEventListener(...args); }
}

const WALL = 1791800000000;

function fakeEnv({ visibility = 'visible', focused = true } = {}) {
  const doc = new CountingTarget();
  doc.visibilityState = visibility;
  doc.focused = focused;
  doc.hasFocus = () => doc.focused;
  const win = new CountingTarget();
  const clock = { t: 1000 };
  return { doc, win, clock, now: () => clock.t, wallNow: () => WALL };
}

afterEach(() => {
  stop();
  setClock(() => performance.now());
});

test('start records one anchor and the state at start', () => {
  start(fakeEnv());
  assert.deepEqual(getEvents(), [
    { type: 'start', t: 1000, wall_ms: WALL },
    { type: 'visibility', state: 'visible', t: 1000, initial: true },
    { type: 'focus', state: 'focus', t: 1000, initial: true },
  ]);
});

test('state at start can be hidden and blurred', () => {
  start(fakeEnv({ visibility: 'hidden', focused: false }));
  const [, vis, foc] = getEvents();
  assert.equal(vis.state, 'hidden');
  assert.equal(foc.state, 'blur');
});

test('records changes with performance.now() times', () => {
  const env = fakeEnv();
  start(env);
  env.clock.t = 2500;
  env.win.dispatchEvent(new Event('blur'));
  env.clock.t = 2501.6;
  env.doc.visibilityState = 'hidden';
  env.doc.dispatchEvent(new Event('visibilitychange'));
  const ev = getEvents();
  assert.equal(ev.length, 5);
  assert.deepEqual(ev[3], { type: 'focus', state: 'blur', t: 2500 });
  assert.deepEqual(ev[4], { type: 'visibility', state: 'hidden', t: 2501.6 });
  assert.equal(ev[0].wall_ms + (ev[3].t - ev[0].t), 1791800001500);
});

test('every handler run is timed for proc_ms, even a repeat that is not recorded (D029)', () => {
  let c = 0;
  setClock(() => (c += 0.25));
  const env = fakeEnv();
  start(env);
  takeSpent();
  env.win.dispatchEvent(new Event('blur'));
  env.win.dispatchEvent(new Event('blur'));
  env.win.dispatchEvent(new Event('pagehide'));
  assert.equal(takeSpent(), 0.75);
});

test('a repeat of the same state is not recorded', () => {
  const env = fakeEnv({ focused: false });
  start(env);
  env.clock.t = 3000;
  env.win.dispatchEvent(new Event('focus'));
  env.clock.t = 3000.1;
  env.win.dispatchEvent(new Event('focus'));
  env.doc.dispatchEvent(new Event('visibilitychange'));
  const ev = getEvents();
  assert.equal(ev.length, 4);
  assert.deepEqual(ev[3], { type: 'focus', state: 'focus', t: 3000 });
});

test('stop removes every listener and records nothing afterwards', () => {
  const env = fakeEnv();
  start(env);
  assert.equal(env.doc.added + env.win.added, 5);
  env.clock.t = 4000;
  stop();
  assert.equal(env.doc.removed, env.doc.added);
  assert.equal(env.win.removed, env.win.added);
  env.win.dispatchEvent(new Event('blur'));
  env.doc.visibilityState = 'hidden';
  env.doc.dispatchEvent(new Event('visibilitychange'));
  const ev = getEvents();
  assert.equal(ev.length, 4);
  assert.deepEqual(ev[3], { type: 'stop', t: 4000 });
});

test('start twice does not attach listeners twice', () => {
  const env = fakeEnv();
  start(env);
  start(env);
  assert.equal(env.doc.added + env.win.added - (env.doc.removed + env.win.removed), 5);
  env.clock.t = 1200;
  env.win.dispatchEvent(new Event('blur'));
  assert.equal(getEvents().length, 4);
});

test('stop when not running does nothing', () => {
  const before = getEvents().length;
  stop();
  stop();
  assert.equal(getEvents().length, before);
});

test('onEvent receives a copy of every new record', () => {
  const env = fakeEnv();
  const got = [];
  start(env, { onEvent: (e) => got.push(e) });
  env.clock.t = 2000;
  env.win.dispatchEvent(new Event('blur'));
  env.clock.t = 3000;
  stop();
  assert.deepEqual(got.map((e) => e.type), ['start', 'visibility', 'focus', 'focus', 'stop']);
  got[0].wall_ms = 0;
  assert.equal(getEvents()[0].wall_ms, WALL);
});

test('pagehide is recorded with its persisted flag, and no change is recorded after it (D043)', () => {
  const env = fakeEnv();
  start(env);
  env.clock.t = 5000;
  env.win.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }));
  env.clock.t = 5000.4;
  env.doc.visibilityState = 'hidden';
  env.doc.dispatchEvent(new Event('visibilitychange'));
  env.win.dispatchEvent(new Event('blur'));
  assert.equal(getEvents().length, 4);
  assert.deepEqual(getEvents()[3], { type: 'pagehide', t: 5000, persisted: false });
  const env2 = fakeEnv();
  start(env2);
  env2.clock.t = 6000;
  env2.win.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
  assert.deepEqual(getEvents()[3], { type: 'pagehide', t: 6000, persisted: true });
});

test('the time away stays unknown whichever comes first, pagehide or the change to hidden (D043)', () => {
  for (const hiddenAt of [40500.2, 40499.8]) {
    const env = fakeEnv();
    start(env);
    const hide = () => {
      env.clock.t = hiddenAt;
      env.doc.visibilityState = 'hidden';
      env.doc.dispatchEvent(new Event('visibilitychange'));
    };
    if (hiddenAt < 40500) hide();
    env.clock.t = 40500;
    env.win.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
    if (hiddenAt > 40500) hide();
    env.clock.t = 100000;
    env.doc.visibilityState = 'visible';
    env.doc.dispatchEvent(new Event('visibilitychange'));
    env.win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    const f = computeWindowFeatures(getEvents(), 50000, 30000);
    assert.equal(f.state_known_ms, 0, `hidden at ${hiddenAt}`);
    assert.equal(f.visible_fraction, null, `hidden at ${hiddenAt}`);
  }
});

test('back from the back/forward cache, the state is recorded again with initial', () => {
  const env = fakeEnv();
  start(env);
  env.clock.t = 2000;
  const hide = new Event('pagehide');
  hide.persisted = true;
  env.win.dispatchEvent(hide);
  env.doc.visibilityState = 'hidden';
  env.doc.dispatchEvent(new Event('visibilitychange'));
  env.clock.t = 9000;
  env.doc.visibilityState = 'visible';
  env.doc.dispatchEvent(new Event('visibilitychange'));
  const show = new Event('pageshow');
  show.persisted = true;
  env.win.dispatchEvent(show);
  const ev = getEvents();
  assert.equal(ev.length, 6);
  assert.deepEqual(ev.slice(-2), [
    { type: 'visibility', state: 'visible', t: 9000, initial: true },
    { type: 'focus', state: 'focus', t: 9000, initial: true },
  ]);
  env.win.dispatchEvent(new Event('pageshow'));
  assert.equal(getEvents().length, 6);
  env.clock.t = 9500;
  env.win.dispatchEvent(new Event('blur'));
  assert.deepEqual(getEvents().at(-1), { type: 'focus', state: 'blur', t: 9500 });
});

test('after the back/forward cache, a later change from the state found at pageshow is recorded', () => {
  const env = fakeEnv();
  start(env);
  env.clock.t = 2000;
  env.win.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
  env.doc.focused = false;
  env.clock.t = 5000;
  env.win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  env.clock.t = 6000;
  env.win.dispatchEvent(new Event('focus'));
  const ev = getEvents();
  assert.equal(ev.length, 7);
  assert.deepEqual(ev[5], { type: 'focus', state: 'blur', t: 5000, initial: true });
  assert.deepEqual(ev[6], { type: 'focus', state: 'focus', t: 6000 });
});

test('getEvents returns copies', () => {
  start(fakeEnv());
  getEvents()[0].wall_ms = 0;
  assert.equal(getEvents()[0].wall_ms, WALL);
});
