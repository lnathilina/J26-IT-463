// Shows random content questions in the class tab and records each outcome.
import { DEFAULTS, GENERATOR, buildSchedule, checkOptions, itemFor, makeSeed, seedHash } from './scheduler.js';
import { timed } from './timing.js';

const STATE_KEY = 'c1.probe';
const LOCK_NAME = 'c1-probe';
const KEEP_TICKS_MS = 20 * 60 * 1000;
const SAVE_EVERY_MS = 10 * 1000;
// Full-screen elements that cannot hold the question panel.
const NO_CHILDREN = /^(VIDEO|AUDIO|IMG|CANVAS|IFRAME|OBJECT|EMBED|INPUT|TEXTAREA|SELECT)$/;
const HTML_NS = 'http://www.w3.org/1999/xhtml';
let run = null;
let generation = 0;

// Loads or draws this session's schedule and checks for due probes every second.
export async function start(env = browserEnv(), { sessionId, emit, bank, store = null, options = {}, onNotice = () => {} }) {
  if (run) stop();
  const gen = (generation += 1);
  const saved = load(store, sessionId);
  const o = saved?.options ?? { ...DEFAULTS, ...options };
  if (saved?.options && JSON.stringify(saved.options) !== JSON.stringify({ ...DEFAULTS, ...options })) {
    onNotice('This session keeps the probe timing it started with.');
  }
  checkOptions(o);
  const release = await acquireLock(env.locks, onNotice);
  if (!release) {
    onNotice('Probes already run in another tab of this browser, so this tab shows none.');
    return false;
  }
  const state = saved ?? { session_id: sessionId, seed: makeSeed(env.random), start_ms: env.timeOrigin + env.now(),
    options: o, done: [], fired: {}, waiting: null, last_tick: null };
  const hash = saved ? null : await seedHash(state.seed);
  if (gen !== generation) {
    release();
    return false;
  }
  const r = { env, o, emit, bank, store, state, release, open: null, stops: [], ticks: [], savedAt: env.now(),
    schedule: buildSchedule(state.seed, o), visibility: [[env.now(), env.doc.visibilityState]] };
  run = r;
  if (!saved) {
    save(r);
    emit('probe_schedule', env.now(), { method: 'block-random', scope: 'per-student', start_ms: state.start_ms,
      gap_ms: o.gapMs, block_ms: o.blockMs, first_block: o.firstBlock, pending_ms: o.pendingMs, answer_ms: o.answerMs,
      upper_ms: o.upperMs, generator: GENERATOR, seed_sha256: hash, bank_version: bank.version });
  }
  listen(r, env.doc, 'visibilitychange', () => {
    r.visibility.push([env.now(), env.doc.visibilityState]);
    if (env.doc.visibilityState === 'hidden') save(r);
    check(r);
  });
  listen(r, env.win, 'pagehide', () => pageHide(r));
  listen(r, env.win, 'pageshow', (e) => {
    if (!e.persisted) return;
    r.visibility.push([env.now(), env.doc.visibilityState]);
    check(r);
  });
  r.stops.push(env.every(1000, timed(() => check(r))));
  check(r);
  return o;
}

// Keeps recent tick seqs so a probe can name the window it belongs to.
export function noteTick(seq, t) {
  if (!run) return;
  run.ticks.push([t, seq]);
  while (run.ticks.length > 1 && run.ticks[1][0] <= t - KEEP_TICKS_MS) run.ticks.shift();
  run.state.last_tick = [run.env.timeOrigin + t, seq];
  if (t - run.savedAt >= SAVE_EVERY_MS) save(run);
}

// Closes any open probe as stopped and logs the seed.
export function stop() {
  generation += 1;
  if (!run) return;
  const r = run;
  if (r.open) close(r, r.open.block, 'stopped');
  check(r, false);
  if (r.state.waiting) close(r, r.state.waiting.block, 'stopped');
  r.emit('probe_seed', r.env.now(), { seed: r.state.seed });
  r.stops.forEach((fn) => fn());
  r.release();
  try { r.store?.removeItem(STATE_KEY); } catch { }
  run = null;
}

export const answer = timed((n) => {
  const r = run;
  if (!r?.open) return;
  const ms = r.env.now() - r.open.shownT;
  if (ms > r.o.answerMs) return;
  close(r, r.open.block, n === r.open.item.correct ? 'correct' : 'incorrect', { chosen: n, response_ms: ms });
});

export const skip = timed(() => {
  const r = run;
  if (!r?.open || r.env.now() - r.open.shownT > r.o.answerMs) return;
  close(r, r.open.block, 'skipped');
});

// Keys 1-4 answer and Esc skips, except while typing in a field.
export function keyAction(e) {
  const el = e.composedPath?.()[0] ?? e.target;
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  if (el?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName ?? '')) return null;
  if (/^[1-4]$/.test(e.key)) return { answer: Number(e.key) };
  if (e.key === 'Escape') return { skip: true };
  return null;
}

// Times out an open probe, or fires the newest due one: shown if the tab is visible, else kept waiting.
function check(r, canShow = true) {
  const t = r.env.now();
  if (r.open) {
    if (t - r.open.shownT >= r.o.answerMs) close(r, r.open.block, 'timeout');
    return;
  }
  const due = r.schedule.filter((p) => fireT(r, p) <= t && !r.state.done.includes(p.block));
  if (due.length === 0) return;
  const newest = due.at(-1);
  for (const p of due.slice(0, -1)) closeUnseen(r, p);
  fire(r, newest);
  if (r.state.done.includes(newest.block)) return;
  if (t - fireT(r, newest) > r.o.pendingMs) return closeUnseen(r, newest);
  if (canShow && r.env.doc.visibilityState === 'visible') return show(r, newest);
  if (!r.state.waiting) {
    r.state.waiting = { block: newest.block, away: wasAway(r, fireT(r, newest)) };
    save(r);
  }
}

function fire(r, p) {
  if (r.state.fired[p.block]) return;
  const { item } = itemFor(r.state.seed, r.schedule, p.block, (ms) => r.bank.segmentAt(ms));
  const fired = { probe_id: item?.id ?? null, fired_t_ms: r.state.start_ms + p.offsetMs, window_seq: windowSeqAt(r, fireT(r, p)) };
  r.state.fired[p.block] = { ...fired, item };
  r.emit('probe_fired', r.env.now(), { block: p.block, mode: 'random', ...fired });
  save(r);
  if (!item) close(r, p.block, 'void', { reason: 'no item' });
}

function show(r, p) {
  const { item } = r.state.fired[p.block];
  r.state.waiting = null;
  r.state.done.push(p.block);
  save(r);
  r.open = { block: p.block, item, shownT: r.env.now() };
  r.emit('probe_shown', r.open.shownT, { block: p.block, mode: 'random', probe_id: item.id });
  const block = p.block;
  r.open.cancel = r.env.after(r.o.answerMs, timed(() => { if (r.open?.block === block) close(r, block, 'timeout'); }));
  r.env.ui.show(item, { answer, skip });
}

function closeUnseen(r, p) {
  fire(r, p);
  if (r.state.done.includes(p.block)) return;
  const away = r.state.waiting?.block === p.block ? r.state.waiting.away : wasAway(r, fireT(r, p));
  close(r, p.block, away ? 'not_shown' : 'not_seen');
}

// Records the outcome once and hides the panel.
function close(r, block, outcome, { chosen = null, response_ms = null, reason = null } = {}) {
  const fired = r.state.fired[block] ?? {};
  r.emit('probe_result', r.env.now(), { block, mode: 'random', probe_id: fired.probe_id ?? null, outcome,
    chosen, response_ms, fired_t_ms: fired.fired_t_ms ?? null, window_seq: fired.window_seq ?? null, reason });
  if (r.open?.block === block) {
    r.open.cancel();
    r.open = null;
    r.env.ui.hide();
  }
  if (r.state.waiting?.block === block) r.state.waiting = null;
  if (!r.state.done.includes(block)) r.state.done.push(block);
  save(r);
}

function pageHide(r) {
  if (r.open) close(r, r.open.block, 'interrupted');
  check(r, false);
  r.visibility.push([r.env.now(), 'away']);
  save(r);
}

function fireT(r, p) {
  return (r.state.start_ms - r.env.timeOrigin) + p.offsetMs;
}

// True if the page was gone at time t, or nothing is known yet.
function wasAway(r, t) {
  const known = r.visibility.filter(([when]) => when <= t);
  return known.length === 0 || known.at(-1)[1] === 'away';
}

function windowSeqAt(r, t) {
  const before = r.ticks.filter(([when]) => when <= t);
  if (before.length) return before.at(-1)[1];
  const last = r.state.last_tick;
  return last && last[0] <= r.env.timeOrigin + t ? last[1] : null;
}

// The schedule is kept in sessionStorage, so a reload does not change it.
function load(store, sessionId) {
  try {
    const s = JSON.parse(store?.getItem(STATE_KEY) ?? 'null');
    return s?.session_id === sessionId ? s : null;
  } catch {
    return null;
  }
}

function save(r) {
  r.savedAt = r.env.now();
  try { r.store?.setItem(STATE_KEY, JSON.stringify(r.state)); } catch { }
}

function listen(r, target, name, handler) {
  const wrapped = timed(handler);
  target.addEventListener(name, wrapped);
  r.stops.push(() => target.removeEventListener(name, wrapped));
}

// Only one tab per browser runs probes.
async function acquireLock(locks, onNotice) {
  if (!locks) {
    onNotice('This browser cannot stop a second tab from running probes (no Web Locks).');
    return () => {};
  }
  return new Promise((resolve) => {
    locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
      if (!lock) return resolve(null);
      return new Promise((release) => resolve(release));
    }).catch((err) => {
      onNotice(`This browser refused Web Locks (${err?.name ?? 'Error'}), so a second tab cannot be stopped from running probes.`);
      resolve(() => {});
    });
  });
}

// Where the panel goes: the full-screen element if it can hold one, else the body.
export function host(doc) {
  const full = doc.fullscreenElement;
  if (!full) return doc.body;
  if (full.namespaceURI === HTML_NS && !NO_CHILDREN.test(full.tagName)) return full;
  doc.exitFullscreen?.();
  return doc.body;
}

// The question panel; it never takes focus away from the page.
export function createPanel(doc) {
  const live = Object.assign(doc.createElement('div'), { className: 'c1-probe-live' });
  live.setAttribute('aria-live', 'assertive');
  live.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)';
  let panel = null;
  let before = null;
  let onKey = null;
  const move = () => { if (panel) host(doc).append(panel, live); };

  return {
    show(item, { answer: pick, skip: pass }) {
      before = doc.activeElement;
      panel = doc.createElement('div');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'false');
      panel.setAttribute('aria-label', 'Quick question about the lecture');
      panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:360px;'
        + 'background:#fff;color:#111;border:2px solid #2a78d6;border-radius:8px;padding:12px;font:15px system-ui,sans-serif';
      const question = Object.assign(doc.createElement('p'), { textContent: item.text });
      question.style.margin = '0 0 8px';
      const help = Object.assign(doc.createElement('p'), { textContent: 'Press 1 to 4 to answer, or Esc to skip. Closes by itself after 15 s.' });
      help.style.cssText = 'margin:0 0 8px;font-size:13px;color:#52514e';
      panel.append(question, help);
      item.options.forEach((text, i) => {
        const b = Object.assign(doc.createElement('button'), { type: 'button', textContent: `${i + 1}. ${text}` });
        b.style.cssText = 'display:block;width:100%;text-align:left;margin:4px 0;padding:6px 8px;font:inherit';
        b.addEventListener('click', () => pick(i + 1));
        panel.append(b);
      });
      const s = Object.assign(doc.createElement('button'), { type: 'button', textContent: 'Skip' });
      s.style.cssText = 'margin-top:6px;padding:4px 10px;font:inherit';
      s.addEventListener('click', () => pass());
      panel.append(s);
      host(doc).append(panel, live);
      live.textContent = `Quick question: ${item.text} ${item.options.map((o, i) => `${i + 1}: ${o}.`).join(' ')} Press 1 to 4, or Esc to skip.`;
      onKey = (e) => {
        const act = keyAction(e);
        if (act?.answer) pick(act.answer);
        else if (act?.skip) pass();
      };
      doc.addEventListener('keydown', onKey);
      doc.addEventListener('fullscreenchange', move);
    },
    hide() {
      if (!panel) return;
      const hadFocus = panel.contains(doc.activeElement);
      doc.removeEventListener('keydown', onKey);
      doc.removeEventListener('fullscreenchange', move);
      panel.remove();
      live.textContent = '';
      panel = null;
      if (hadFocus && before?.isConnected) before.focus();
    },
  };
}

function browserEnv() {
  return {
    doc: document,
    win: window,
    now: () => performance.now(),
    timeOrigin: performance.timeOrigin,
    every: (ms, fn) => { const id = setInterval(fn, ms); return () => clearInterval(id); },
    after: (ms, fn) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); },
    locks: navigator.locks,
    random: (a) => crypto.getRandomValues(a),
    ui: createPanel(document),
  };
}
