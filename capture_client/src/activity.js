// Counts pointer, touch and key activity per bucket without reading what was typed or where.
import { timed, takeSpent } from './timing.js';

const KINDS = ['pointer', 'touch', 'key'];
// Capture phase sees each event first; passive never blocks scrolling.
const OPTIONS = { capture: true, passive: true };
let rows = [];
let stopFns = [];
let cancelTimer = null;
let restartTimer = null;
let clock = null;
let bucket = null;
let gone = false;
let cached = false;
let onRow = null;

// Attaches the counters and the 1 s timer that closes each bucket.
export function start(env = browserEnv(), { bucketMs = 1000, slotMs = 250, onRow: rowHook = null } = {}) {
  if (stopFns.length > 0) stop();
  const { doc, win, now, every } = env;
  clock = now;
  rows = [];
  onRow = rowHook;
  gone = false;
  cached = false;
  bucket = newBucket(now(), bucketMs, slotMs);

  listen(doc, 'pointermove', (e) => { if (e.pointerType !== 'touch') note('pointer'); });
  listen(doc, 'touchmove', () => note('touch'));
  listen(doc, 'keydown', (e) => { if (!e.repeat) note('key'); });
  listen(win, 'pagehide', (e) => { flush(); gone = true; cached = Boolean(e.persisted); });
  listen(win, 'pageshow', (e) => {
    if (!e.persisted) return;
    gone = false;
    cached = false;
    bucket = newBucket(clock(), bucket.bucketMs, bucket.slotMs);
    restartTimer();
  });
  listen(doc, 'visibilitychange', () => {
    if (gone) return;
    closeIfLonger(clock());
    restartTimer();
  });
  restartTimer = () => {
    if (cancelTimer) cancelTimer();
    cancelTimer = every(bucketMs, timed(() => { if (!cached) close(now()); }));
  };
  restartTimer();
  stopFns.push(() => cancelTimer());
}

export function stop() {
  if (stopFns.length === 0) return;
  stopFns.forEach((fn) => fn());
  stopFns = [];
  closeIfLonger(clock());
}

// Saves the part-second before the page goes away.
function flush() {
  if (stopFns.length > 0) closeIfLonger(clock());
}

// Closes the bucket early, but never writes a zero-length row.
function closeIfLonger(t) {
  if (t > bucket.start) close(t);
}

export function getRows() {
  return rows.map((r) => ({ ...r }));
}

function newBucket(start, bucketMs, slotMs) {
  const b = { start, bucketMs, slotMs, count: {}, slots: {} };
  for (const k of KINDS) { b.count[k] = 0; b.slots[k] = new Set(); }
  return b;
}

// Counts one event and marks which 250 ms slot it fell in.
function note(kind) {
  const t = clock();
  bucket.count[kind] += 1;
  bucket.slots[kind].add(Math.floor((t - bucket.start) / bucket.slotMs));
}

// Writes the bucket as one row and opens the next.
function close(t) {
  const length = t - bucket.start;
  const normal = length < bucket.bucketMs + bucket.slotMs;
  const lastSlot = Math.round(bucket.bucketMs / bucket.slotMs) - 1;
  const row = { t, bucket_ms: length };
  for (const k of KINDS) {
    const slots = normal ? new Set([...bucket.slots[k]].map((s) => Math.min(s, lastSlot))) : bucket.slots[k];
    row[`${k}_count`] = bucket.count[k];
    row[`${k}_slots`] = slots.size;
  }
  row.proc_ms = takeSpent();
  rows.push(row);
  if (onRow) onRow({ ...row });
  bucket = newBucket(t, bucket.bucketMs, bucket.slotMs);
}

// Adds a timed listener that stop() can remove.
function listen(target, name, handler) {
  const run = timed(handler);
  target.addEventListener(name, run, OPTIONS);
  stopFns.push(() => target.removeEventListener(name, run, OPTIONS));
}

function browserEnv() {
  return {
    doc: document,
    win: window,
    now: () => performance.now(),
    every: (ms, fn) => {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    },
  };
}
