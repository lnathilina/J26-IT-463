// Tests for src/probe.js (run from capture_client/ with npm test).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as probe from '../src/probe.js';
import { buildSchedule, itemOrder } from '../src/scheduler.js';
import { setClock, takeSpent } from '../src/timing.js';
import { createHash } from 'node:crypto';

function steppingClock(step) {
  let c = 0;
  return () => (c += step);
}

const T0 = 1792000000000;
const SEED = '00000001000000020000000300000004';
const O = { blockMs: 60000, gapMs: 30000, pendingMs: 10000, answerMs: 15000, upperMs: 600000 };
const SCHEDULE = buildSchedule(SEED, O);
const ITEMS = [1, 2, 3].map((n) => ({ id: `Q${n}`, text: `Question ${n}`, options: ['a', 'b', 'c', 'd'], correct: n }));
const BANK = { version: 'test-1', segmentAt: (ms) => ({ id: `S${Math.floor(ms / 120000)}`, items: ITEMS }) };

// A fake page: document, window, clock, timers and a panel that only records.
function fakeEnv({ visible = true, timeOrigin = T0, locks } = {}) {
  const doc = new EventTarget();
  doc.visibilityState = visible ? 'visible' : 'hidden';
  const timers = [];
  const ui = { shown: [], hides: 0, show(item) { this.shown.push(item); }, hide() { this.hides += 1; } };
  return {
    doc, win: new EventTarget(), clock: { t: 0 }, timers, ui, timeOrigin, locks,
    now() { return this.clock.t; },
    every: (ms, fn) => { const x = { every: true, fn }; timers.push(x); return () => { x.cancelled = true; }; },
    after(ms, fn) { const x = { at: this.clock.t + ms, fn }; timers.push(x); return () => { x.cancelled = true; }; },
    random: (a) => { a.set([1, 2, 3, 4]); return a; },
  };
}
function fakeStore() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
// Moves the clock to t and runs every timer that is due.
function tickTo(env, t) {
  env.clock.t = t;
  for (const x of env.timers.filter((x) => !x.every && !x.cancelled && !x.done && x.at <= t)) { x.done = true; x.fn(); }
  for (const x of env.timers.filter((x) => x.every && !x.cancelled)) x.fn();
}
function runOneOff(env, t) {
  env.clock.t = t;
  for (const x of env.timers.filter((x) => !x.every && !x.cancelled && !x.done && x.at <= t)) { x.done = true; x.fn(); }
}
function setVisible(env, visible, t) {
  env.clock.t = t;
  env.doc.visibilityState = visible ? 'visible' : 'hidden';
  env.doc.dispatchEvent(new Event('visibilitychange'));
}
// Starts probes on a fake page and collects the records they emit.
async function begin(env, { store = fakeStore(), bank = BANK, mod = probe } = {}) {
  const records = [];
  const notices = [];
  const ok = await mod.start(env, { sessionId: 'S1', emit: (type, t, f) => records.push({ type, t, ...f }), bank, store,
    options: O, onNotice: (m) => notices.push(m) });
  return { records, store, ok, notices };
}
const of = (records, type) => records.filter((r) => r.type === type);
const fire = (k) => SCHEDULE.find((p) => p.block === k).offsetMs;

afterEach(() => probe.stop());

test('start logs the schedule with the seed hash, not the seed', async () => {
  const { records } = await begin(fakeEnv());
  const [s] = of(records, 'probe_schedule');
  assert.equal(s.seed_sha256.length, 64);
  assert.equal(JSON.stringify(records).includes(SEED), false);
  assert.deepEqual([s.gap_ms, s.block_ms, s.first_block, s.pending_ms, s.answer_ms], [30000, 60000, 1, 10000, 15000]);
  assert.equal(s.start_ms, T0);
});

test('a probe fires at its drawn time, shows, and a correct answer is recorded', async () => {
  const env = fakeEnv();
  const { records } = await begin(env);
  probe.noteTick(41, fire(1) - 500);
  probe.noteTick(42, fire(1) + 500);
  tickTo(env, fire(1) - 1);
  assert.equal(env.ui.shown.length, 0);
  tickTo(env, fire(1));
  const item = env.ui.shown[0];
  assert.equal(item.id, ITEMS[itemOrder(SEED, 'S0', 3)[0]].id);
  env.clock.t = fire(1) + 6000;
  probe.answer(item.correct);
  const [r] = of(records, 'probe_result');
  assert.deepEqual([r.block, r.mode, r.outcome, r.chosen, r.response_ms, r.window_seq], [1, 'random', 'correct', item.correct, 6000, 41]);
  assert.equal(r.fired_t_ms, T0 + fire(1));
  assert.equal(env.ui.hides, 1);
});

test('a wrong answer is incorrect, with the option chosen', async () => {
  const env = fakeEnv();
  const { records } = await begin(env);
  tickTo(env, fire(1));
  const wrong = (env.ui.shown[0].correct % 4) + 1;
  probe.answer(wrong);
  const [r] = of(records, 'probe_result');
  assert.deepEqual([r.outcome, r.chosen], ['incorrect', wrong]);
});

test('15 s: an answer at exactly 15,000 ms counts; at 15,001 ms it does not', async () => {
  const env = fakeEnv();
  const { records } = await begin(env);
  tickTo(env, fire(1));
  env.clock.t = fire(1) + 15000;
  probe.answer(env.ui.shown[0].correct);
  assert.equal(of(records, 'probe_result')[0].outcome, 'correct');
  tickTo(env, fire(2));
  env.clock.t = fire(2) + 15001;
  probe.answer(env.ui.shown[1].correct);
  runOneOff(env, fire(2) + 15001);
  const r = of(records, 'probe_result')[1];
  assert.deepEqual([r.outcome, r.chosen, r.response_ms], ['timeout', null, null]);
  assert.equal(env.ui.hides, 2);
});

test('Skip is recorded as skipped, with no answer and no response time', async () => {
  const env = fakeEnv();
  const { records } = await begin(env);
  tickTo(env, fire(1));
  probe.skip();
  const [r] = of(records, 'probe_result');
  assert.deepEqual([r.outcome, r.chosen, r.response_ms], ['skipped', null, null]);
});

test('hidden at the drawn time: the probe waits and shows when the tab is visible again', async () => {
  const env = fakeEnv({ visible: false });
  const { records } = await begin(env);
  tickTo(env, fire(1));
  assert.equal(env.ui.shown.length, 0);
  setVisible(env, true, fire(1) + 6000);
  assert.equal(env.ui.shown.length, 1);
  assert.equal(of(records, 'probe_shown')[0].t, fire(1) + 6000);
  tickTo(env, fire(1) + 6000 + 14999);
  assert.equal(of(records, 'probe_result').length, 0);
  tickTo(env, fire(1) + 6000 + 15000);
  assert.equal(of(records, 'probe_result')[0].outcome, 'timeout');
});

test('hidden past the waiting limit: not_seen', async () => {
  const env = fakeEnv({ visible: false });
  const { records } = await begin(env);
  tickTo(env, fire(1));
  tickTo(env, fire(1) + 10001);
  const [r] = of(records, 'probe_result');
  assert.equal(r.outcome, 'not_seen');
  assert.equal(env.ui.shown.length, 0);
});

test('a long gap with no checks (e.g. a sleep) past two drawn times: the older closes, the newest shows', async () => {
  const env = fakeEnv();
  const { records } = await begin(env);
  tickTo(env, fire(2) + 3000);
  const results = of(records, 'probe_result');
  assert.deepEqual(results.map((r) => [r.block, r.outcome]), [[1, 'not_seen']]);
  assert.equal(of(records, 'probe_shown')[0].block, 2);
  assert.deepEqual(of(records, 'probe_fired').map((r) => r.fired_t_ms), [T0 + fire(1), T0 + fire(2)]);
});

test('visible at the drawn time but hidden before the next check, away past the limit: not_seen', async () => {
  const env = fakeEnv();
  const { records } = await begin(env);
  tickTo(env, fire(1) - 100);
  setVisible(env, false, fire(1) + 300);
  tickTo(env, fire(1) + 20000);
  assert.equal(of(records, 'probe_result')[0].outcome, 'not_seen');
});

test('back/forward cache: a drawn time while the page was away is not_shown; inside the limit it shows late', async () => {
  const env = fakeEnv();
  const { records } = await begin(env);
  env.clock.t = fire(1) - 5000;
  env.win.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
  env.clock.t = fire(1) + 20000;
  env.win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  assert.equal(of(records, 'probe_result')[0].outcome, 'not_shown');
  env.clock.t = fire(2) - 5000;
  env.win.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
  env.clock.t = fire(2) + 4000;
  env.win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  assert.equal(of(records, 'probe_shown').at(-1).block, 2);
});

test('a probe waiting in a hidden tab still waits after a reload, and shows when visible', async () => {
  const store = fakeStore();
  const env1 = fakeEnv({ visible: false });
  await begin(env1, { store });
  tickTo(env1, fire(1));
  env1.win.dispatchEvent(new Event('pagehide'));
  const reloaded = await import('../src/probe.js?waiting');
  const env2 = fakeEnv({ timeOrigin: T0 + fire(1) + 4000 });
  const second = await begin(env2, { store, mod: reloaded });
  tickTo(env2, 0);
  assert.equal(of(second.records, 'probe_shown')[0]?.block, 1);
  reloaded.stop();
});

test('a reload keeps the options the session started with', async () => {
  const store = fakeStore();
  const env1 = fakeEnv();
  await begin(env1, { store });
  env1.win.dispatchEvent(new Event('pagehide'));
  const reloaded = await import('../src/probe.js?options');
  const env2 = fakeEnv({ timeOrigin: T0 + 1000 });
  const records = [];
  const notices = [];
  await reloaded.start(env2, { sessionId: 'S1', emit: (type, t, f) => records.push({ type, t, ...f }), bank: BANK, store,
    options: { ...O, blockMs: 120000 }, onNotice: (m) => notices.push(m) });
  tickTo(env2, (T0 - env2.timeOrigin) + fire(1));
  assert.equal(of(records, 'probe_fired')[0].fired_t_ms, T0 + fire(1));
  assert.equal(of(records, 'probe_schedule').length, 0);
  assert.match(notices.join(' '), /keeps the probe timing/);
  reloaded.stop();
});

test('Stop while start still waits for the lock: start gives up and releases the lock', async () => {
  let grant;
  let released = false;
  const slow = { request: (name, opts, cb) => new Promise((done) => { grant = () => cb({}).then(() => { released = true; done(); }); }) };
  const env = fakeEnv({ locks: slow });
  const records = [];
  const started = probe.start(env, { sessionId: 'S1', emit: (type, t, f) => records.push({ type, t, ...f }), bank: BANK, options: O });
  probe.stop();
  grant();
  assert.equal(await started, false);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(records.length, 0);
  assert.equal(released, true);
});

test('Skip after 15 s is refused, like a late answer: timeout', async () => {
  const env = fakeEnv();
  const { records } = await begin(env);
  tickTo(env, fire(1));
  env.clock.t = fire(1) + 15400;
  probe.skip();
  tickTo(env, fire(1) + 15400);
  assert.equal(of(records, 'probe_result')[0].outcome, 'timeout');
});

test('after a crash, the window id comes from a last tick saved at most about 10 s earlier', async () => {
  const store = fakeStore();
  const env1 = fakeEnv();
  await begin(env1, { store });
  for (let s = 1; s <= 30; s += 1) { env1.clock.t = s * 1000; probe.noteTick(100 + s, s * 1000); }
  const reloaded = await import('../src/probe.js?crashtick');
  const env2 = fakeEnv({ timeOrigin: T0 + fire(1) + 2000 });
  const second = await begin(env2, { store, mod: reloaded });
  tickTo(env2, 0);
  assert.equal(of(second.records, 'probe_fired')[0].window_seq, 130);
  reloaded.stop();
});

test('probe work is timed, so it counts in proc_ms (D029)', async () => {
  const env = fakeEnv();
  await begin(env);
  setClock(steppingClock(0.25));
  takeSpent();
  tickTo(env, 5000);
  assert.equal(takeSpent(), 0.25);
  setClock(() => performance.now());
});

test('the panel goes inside a fullscreen element that can draw it, else the page leaves fullscreen', () => {
  const HTML = 'http://www.w3.org/1999/xhtml';
  const body = { tagName: 'BODY' };
  let left = 0;
  const leave = () => { left += 1; };
  const div = { tagName: 'DIV', namespaceURI: HTML };
  assert.equal(probe.host({ fullscreenElement: null, body }), body);
  assert.equal(probe.host({ fullscreenElement: div, body }), div);
  assert.equal(probe.host({ fullscreenElement: { tagName: 'VIDEO', namespaceURI: HTML }, body, exitFullscreen: leave }), body);
  assert.equal(probe.host({ fullscreenElement: { tagName: 'svg', namespaceURI: 'http://www.w3.org/2000/svg' }, body, exitFullscreen: leave }), body);
  assert.equal(left, 2);
});

test('closing the page while a probe is open: interrupted; a reload never shows it again', async () => {
  const store = fakeStore();
  const env1 = fakeEnv();
  const { records } = await begin(env1, { store });
  tickTo(env1, fire(1));
  env1.win.dispatchEvent(new Event('pagehide'));
  assert.equal(of(records, 'probe_result')[0].outcome, 'interrupted');
  const reloaded = await import('../src/probe.js?reload');
  const env2 = fakeEnv({ timeOrigin: T0 + fire(1) + 2000 });
  const second = await begin(env2, { store, mod: reloaded });
  tickTo(env2, 1000);
  assert.equal(env2.ui.shown.length, 0);
  assert.equal(of(second.records, 'probe_schedule').length, 0);
  tickTo(env2, (T0 - env2.timeOrigin) + fire(2));
  assert.equal(env2.ui.shown.length, 1);
  reloaded.stop();
});

test('a crash with a probe open (no pagehide): after a reload it is not shown again', async () => {
  const store = fakeStore();
  const env1 = fakeEnv();
  await begin(env1, { store });
  tickTo(env1, fire(1));
  const reloaded = await import('../src/probe.js?crash');
  const env2 = fakeEnv({ timeOrigin: T0 + fire(1) + 5000 });
  const second = await begin(env2, { store, mod: reloaded });
  tickTo(env2, 0);
  assert.equal(env2.ui.shown.length, 0);
  assert.equal(of(second.records, 'probe_shown').length, 0);
  reloaded.stop();
});

test('Stop: an open probe becomes stopped, the seed is logged, the saved state is removed', async () => {
  const store = fakeStore();
  const env = fakeEnv();
  const { records } = await begin(env, { store });
  tickTo(env, fire(1));
  probe.stop();
  assert.deepEqual(records.slice(-2).map((r) => r.type), ['probe_result', 'probe_seed']);
  assert.equal(of(records, 'probe_result')[0].outcome, 'stopped');
  assert.equal(of(records, 'probe_seed')[0].seed, SEED);
  assert.equal(store.getItem('c1.probe'), null);
  tickTo(env, fire(2));
  assert.equal(of(records, 'probe_fired').length, 1);
});

test('Stop while a probe waits in a hidden tab: stopped', async () => {
  const env = fakeEnv({ visible: false });
  const { records } = await begin(env);
  tickTo(env, fire(1));
  probe.stop();
  assert.equal(of(records, 'probe_result')[0].outcome, 'stopped');
});

test('a segment with no item left: void, with the reason', async () => {
  const one = { version: 't', segmentAt: (ms) => ({ id: `S${Math.floor(ms / 120000)}`, items: [ITEMS[0]] }) };
  const env = fakeEnv();
  const { records } = await begin(env, { bank: one });
  tickTo(env, fire(2));
  probe.answer(1);
  tickTo(env, fire(3));
  const r = of(records, 'probe_result').at(-1);
  assert.deepEqual([r.block, r.outcome, r.reason, r.probe_id], [3, 'void', 'no item', null]);
  assert.equal(env.ui.shown.length, 1);
});

test('the drawn times and questions do not depend on visibility or answers (FR7)', async () => {
  const runA = fakeEnv();
  const a = await begin(runA);
  for (const p of SCHEDULE) { tickTo(runA, p.offsetMs); if (runA.ui.shown.length) probe.answer(1); }
  probe.stop();
  const runB = fakeEnv({ visible: false });
  const b = await begin(runB);
  for (const p of SCHEDULE) tickTo(runB, p.offsetMs + 20000);
  const fired = (rs) => of(rs, 'probe_fired').map((r) => [r.block, r.fired_t_ms, r.probe_id]);
  assert.equal(of(a.records, 'probe_fired').length, 9);
  assert.deepEqual(fired(a.records), fired(b.records));
});

test('a second tab of the same browser runs no probes', async () => {
  const taken = { request: (name, opts, cb) => Promise.resolve(cb(null)) };
  const env = fakeEnv({ locks: taken });
  const { ok, records, notices } = await begin(env);
  assert.equal(ok, false);
  assert.equal(records.length, 0);
  assert.match(notices[0], /another tab/);
});

test('keys: 1-4 answer and Esc skips, but not in a text field or with Ctrl, Alt or Meta', () => {
  const key = (k, extra = {}) => probe.keyAction({ key: k, target: { tagName: 'BODY' }, ...extra });
  assert.deepEqual(key('3'), { answer: 3 });
  assert.deepEqual(key('Escape'), { skip: true });
  assert.equal(key('5'), null);
  assert.equal(key('a'), null);
  assert.equal(key('2', { target: { tagName: 'TEXTAREA' } }), null);
  assert.equal(key('2', { target: { tagName: 'DIV', isContentEditable: true } }), null);
  assert.equal(key('2', { ctrlKey: true }), null);
  assert.equal(key('2', { altKey: true }), null);
  assert.equal(key('2', { metaKey: true }), null);
  assert.equal(key('2', { target: { tagName: 'INPUT' } }), null);
  assert.equal(key('2', { target: { tagName: 'SELECT' } }), null);
  assert.equal(key('2', { target: { tagName: 'CHAT-BOX' }, composedPath: () => [{ tagName: 'INPUT' }, { tagName: 'CHAT-BOX' }] }), null);
});

test('records carry the question fixed at the drawn time, in the seeded order (D032)', async () => {
  const bank = { version: 'b', segmentAt: (ms) => ({ id: `B${Math.floor(ms / 120000)}`, items: ITEMS }) };
  assert.deepEqual(itemOrder(SEED, 'B1', 3), [1, 0, 2]);
  const env = fakeEnv();
  const { records } = await begin(env, { bank });
  tickTo(env, fire(2));
  probe.answer(2);
  tickTo(env, fire(3));
  const id = (type, k) => of(records, type).find((r) => r.block === k)?.probe_id;
  assert.deepEqual([id('probe_fired', 2), id('probe_shown', 2), id('probe_result', 2)], ['Q2', 'Q2', 'Q2']);
  assert.deepEqual([id('probe_fired', 3), id('probe_shown', 3), env.ui.shown[1].id], ['Q1', 'Q1', 'Q1']);
  assert.ok(records.filter((r) => r.type.startsWith('probe_') && r.type !== 'probe_schedule').every((r) => r.mode === 'random'));
});

test('the shown question is the one fixed at the drawn time, even if the bank changes', async () => {
  let version = 'A';
  const items = (v) => ITEMS.map((it) => ({ ...it, id: `${v}-${it.id}` }));
  const bank = { version: 'x', segmentAt: (ms) => ({ id: `S${Math.floor(ms / 120000)}`, items: items(version) }) };
  const env = fakeEnv({ visible: false });
  const { records } = await begin(env, { bank });
  tickTo(env, fire(1));
  version = 'B';
  setVisible(env, true, fire(1) + 3000);
  assert.equal(env.ui.shown[0].id.startsWith('A-'), true);
  assert.equal(of(records, 'probe_shown')[0].probe_id, of(records, 'probe_fired')[0].probe_id);
});

test('the logged hash is the SHA-256 of the seed logged at Stop, with what is needed to rebuild the schedule', async () => {
  const env = fakeEnv();
  const { records } = await begin(env);
  probe.stop();
  const [sched] = of(records, 'probe_schedule');
  const [seed] = of(records, 'probe_seed');
  assert.equal(sched.seed_sha256, createHash('sha256').update(seed.seed).digest('hex'));
  assert.deepEqual([sched.upper_ms, sched.bank_version, sched.generator], [600000, 'test-1', 'sfc32-v1']);
});

test('after Stop, events write nothing; the lock is released, so a new start can run', async () => {
  let held = false;
  const lockManager = { request: (name, opts, cb) => {
    if (held) return Promise.resolve(cb(null));
    held = true;
    return Promise.resolve(cb({})).then(() => { held = false; });
  } };
  const env = fakeEnv({ locks: lockManager });
  const { records } = await begin(env);
  probe.stop();
  const n = records.length;
  setVisible(env, false, 1000);
  setVisible(env, true, 2000);
  env.win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  tickTo(env, fire(1));
  assert.equal(records.length, n);
  await Promise.resolve();
  const again = await begin(fakeEnv({ locks: lockManager }));
  assert.ok(again.ok);
});

test('start twice: the first controller stops, so a drawn time fires once', async () => {
  const env = fakeEnv();
  const first = await begin(env);
  const second = await begin(env);
  tickTo(env, fire(1));
  assert.equal(of(first.records, 'probe_fired').length, 0);
  assert.equal(of(second.records, 'probe_fired').length, 1);
});

test('a probe waiting in a hidden tab: a reload into a hidden page, past the limit, gives not_seen', async () => {
  const store = fakeStore();
  const env1 = fakeEnv({ visible: false });
  await begin(env1, { store });
  tickTo(env1, fire(1));
  env1.win.dispatchEvent(new Event('pagehide'));
  const reloaded = await import('../src/probe.js?waithidden');
  const env2 = fakeEnv({ visible: false, timeOrigin: T0 + fire(1) + 4000 });
  const second = await begin(env2, { store, mod: reloaded });
  tickTo(env2, 7000);
  assert.deepEqual(of(second.records, 'probe_result').map((r) => [r.block, r.outcome]), [[1, 'not_seen']]);
  assert.equal(of(second.records, 'probe_fired').length, 0);
  reloaded.stop();
});

test('a drawn time while the tab was closed (no record of the new page yet), back too late: not_shown', async () => {
  const store = fakeStore();
  const env1 = fakeEnv();
  await begin(env1, { store });
  env1.clock.t = fire(1) - 5000;
  env1.win.dispatchEvent(new Event('pagehide'));
  const reloaded = await import('../src/probe.js?closed');
  const env2 = fakeEnv({ timeOrigin: T0 + fire(1) + 20000 });
  const second = await begin(env2, { store, mod: reloaded });
  tickTo(env2, 0);
  const [r] = of(second.records, 'probe_result');
  assert.deepEqual([r.block, r.outcome, r.fired_t_ms], [1, 'not_shown', T0 + fire(1)]);
  reloaded.stop();
});

test('window id: the last tick before the drawn time, not before the check, also across a reload', async () => {
  const env = fakeEnv();
  const { records } = await begin(env);
  probe.noteTick(41, fire(1) - 500);
  probe.noteTick(42, fire(1) + 500);
  tickTo(env, fire(1) + 800);
  assert.equal(of(records, 'probe_fired')[0].window_seq, 41);
  probe.stop();
  const store = fakeStore();
  const env1 = fakeEnv();
  await begin(env1, { store });
  env1.clock.t = fire(1) - 3000;
  probe.noteTick(77, fire(1) - 3000);
  env1.clock.t = fire(1) - 2500;
  probe.noteTick(78, fire(1) - 2500);
  setVisible(env1, false, fire(1) - 2000);
  const reloaded = await import('../src/probe.js?hiddensave');
  const env2 = fakeEnv({ timeOrigin: T0 + fire(1) + 2000 });
  const second = await begin(env2, { store, mod: reloaded });
  tickTo(env2, 0);
  assert.equal(of(second.records, 'probe_fired')[0].window_seq, 78);
  reloaded.stop();
});

test('after a freeze of more than 20 min, the window id keeps the last tick before the drawn time', async () => {
  const env = fakeEnv();
  const { records } = await begin(env);
  probe.noteTick(41, fire(1) - 500);
  const wake = fire(1) + 21 * 60000;
  probe.noteTick(99, wake);
  tickTo(env, wake);
  assert.equal(of(records, 'probe_fired').find((r) => r.block === 1).window_seq, 41);
});

test('after waiting, the response time counts from showing; the limit itself (10,000 ms) still shows', async () => {
  const env = fakeEnv({ visible: false });
  const { records } = await begin(env);
  tickTo(env, fire(1));
  setVisible(env, true, fire(1) + 6000);
  env.clock.t = fire(1) + 11000;
  probe.answer(env.ui.shown[0].correct);
  assert.equal(of(records, 'probe_result')[0].response_ms, 5000);
  setVisible(env, false, fire(2) - 1000);
  tickTo(env, fire(2));
  setVisible(env, true, fire(2) + 10000);
  assert.equal(of(records, 'probe_shown').at(-1).block, 2);
});

test('Stop or pagehide just after a drawn time, before the 1 s check: the probe still fires', async () => {
  const env = fakeEnv();
  const { records } = await begin(env);
  tickTo(env, fire(1) - 400);
  env.clock.t = fire(1) + 600;
  probe.stop();
  assert.deepEqual(records.filter((r) => r.type !== 'probe_schedule').map((r) => [r.type, r.outcome ?? r.block ?? '']),
    [['probe_fired', 1], ['probe_result', 'stopped'], ['probe_seed', '']]);
  const store = fakeStore();
  const env1 = fakeEnv();
  const first = await begin(env1, { store });
  probe.noteTick(41, fire(1) - 400);
  tickTo(env1, fire(1) - 400);
  env1.clock.t = fire(1) + 300;
  env1.win.dispatchEvent(new Event('pagehide'));
  assert.equal(of(first.records, 'probe_fired')[0].window_seq, 41);
  const reloaded = await import('../src/probe.js?f5');
  const env2 = fakeEnv({ timeOrigin: T0 + fire(1) + 3000 });
  const second = await begin(env2, { store, mod: reloaded });
  tickTo(env2, 0);
  assert.equal(of(second.records, 'probe_fired').length, 0);
  assert.equal(of(second.records, 'probe_shown')[0].block, 1);
  reloaded.stop();
});

test('the 15 s timer closes the probe even if the clock reads a hair under 15 s', async () => {
  const env = fakeEnv();
  const { records } = await begin(env);
  tickTo(env, fire(1));
  env.clock.t = fire(1) + 14999.9;
  env.timers.find((x) => !x.every && !x.done && !x.cancelled).fn();
  assert.equal(of(records, 'probe_result')[0].outcome, 'timeout');
  assert.equal(env.ui.hides, 1);
});

test('visibility and page handlers are timed too (D029)', async () => {
  const env = fakeEnv();
  await begin(env);
  setClock(steppingClock(0.25));
  try {
    takeSpent();
    setVisible(env, false, 5000);
    assert.equal(takeSpent(), 0.25);
  } finally {
    setClock(() => performance.now());
  }
});

test('void: probe_fired with no question, then the void result, in that order', async () => {
  const one = { version: 't', segmentAt: (ms) => ({ id: `S${Math.floor(ms / 120000)}`, items: [ITEMS[0]] }) };
  const env = fakeEnv();
  const { records } = await begin(env, { bank: one });
  tickTo(env, fire(2));
  probe.answer(1);
  tickTo(env, fire(3));
  assert.deepEqual(records.slice(-2).map((r) => [r.type, r.block, r.probe_id]), [['probe_fired', 3, null], ['probe_result', 3, null]]);
});

test('a probe shown after waiting is done: a crash and a Stop in the next page write no result for it', async () => {
  const store = fakeStore();
  const env1 = fakeEnv({ visible: false });
  await begin(env1, { store });
  tickTo(env1, fire(1));
  setVisible(env1, true, fire(1) + 3000);
  const reloaded = await import('../src/probe.js?shownthencrash');
  const env2 = fakeEnv({ timeOrigin: T0 + fire(1) + 5000 });
  const second = await begin(env2, { store, mod: reloaded });
  reloaded.stop();
  assert.equal(of(second.records, 'probe_result').length, 0);
});

test('a saved state of another session is ignored: a new schedule starts', async () => {
  const store = fakeStore();
  await begin(fakeEnv(), { store });
  const records = [];
  const reloaded = await import('../src/probe.js?othersession');
  await reloaded.start(fakeEnv(), { sessionId: 'S2', emit: (type, t, f) => records.push({ type, t, ...f }), bank: BANK, store, options: O });
  assert.equal(of(records, 'probe_schedule').length, 1);
  reloaded.stop();
});

test('a refused Web Locks request runs probes and says why (it is not another tab)', async () => {
  const refusing = { request: () => Promise.reject(Object.assign(new Error('denied'), { name: 'SecurityError' })) };
  const { ok, notices } = await begin(fakeEnv({ locks: refusing }));
  assert.ok(ok);
  assert.match(notices.join(' '), /refused Web Locks \(SecurityError\)/);
});

test('back from the cache records the visibility then, so a later tab switch gives not_seen', async () => {
  const env = fakeEnv();
  const { records } = await begin(env);
  env.clock.t = fire(1) - 20000;
  env.win.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
  env.clock.t = fire(1) - 15000;
  env.win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  setVisible(env, false, fire(1) + 300);
  tickTo(env, fire(1) + 10301);
  assert.equal(of(records, 'probe_result')[0].outcome, 'not_seen');
});
