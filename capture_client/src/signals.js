// Records tab visibility and window focus changes, with one wall-clock anchor.
import { timed } from './timing.js';

let events = [];
let removers = [];
let clock = null;
let last = {};
let gone = false;
let onEvent = null;

// Records the state at start, then every real change.
export function start(env = browserEnv(), options = {}) {
  if (removers.length > 0) stop();
  const { doc, win, now, wallNow } = env;
  clock = now;
  events = [];
  gone = false;
  onEvent = options.onEvent ?? null;

  const t0 = now();
  push({ type: 'start', t: t0, wall_ms: wallNow() });

  last = { visibility: doc.visibilityState, focus: doc.hasFocus() ? 'focus' : 'blur' };
  push({ type: 'visibility', state: last.visibility, t: t0, initial: true });
  push({ type: 'focus', state: last.focus, t: t0, initial: true });

  listen(doc, 'visibilitychange', () => record('visibility', doc.visibilityState, now()));
  listen(win, 'focus', () => record('focus', 'focus', now()));
  listen(win, 'blur', () => record('focus', 'blur', now()));
  listen(win, 'pagehide', (e) => {
    push({ type: 'pagehide', t: now(), persisted: Boolean(e.persisted) });
    gone = true;
  });
  listen(win, 'pageshow', (e) => {
    if (!e.persisted) return;
    gone = false;
    const t = now();
    last = { visibility: doc.visibilityState, focus: doc.hasFocus() ? 'focus' : 'blur' };
    push({ type: 'visibility', state: last.visibility, t, initial: true });
    push({ type: 'focus', state: last.focus, t, initial: true });
  });
}

// Skips repeats, and any change after pagehide until the page is shown again.
function record(type, state, t) {
  if (gone) return;
  if (state === last[type]) return;
  last[type] = state;
  push({ type, state, t });
}

function push(e) {
  events.push(e);
  if (onEvent) onEvent({ ...e });
}

export function stop() {
  if (removers.length === 0) return;
  removers.forEach((remove) => remove());
  removers = [];
  push({ type: 'stop', t: clock() });
}

export function getEvents() {
  return events.map((e) => ({ ...e }));
}

// Adds a timed listener that stop() can remove.
function listen(target, name, handler) {
  const run = timed(handler);
  target.addEventListener(name, run);
  removers.push(() => target.removeEventListener(name, run));
}

function browserEnv() {
  return {
    doc: document,
    win: window,
    now: () => performance.now(),
    wallNow: () => Date.now(),
  };
}
