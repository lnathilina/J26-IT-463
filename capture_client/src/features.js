// Works out one window's features from the recorded events and activity rows.
const KINDS = ['pointer', 'touch', 'key'];
const ORDER = { start: 0, pagehide: 2, stop: 2 };
// After these the state is unknown until a new record sets it.
const ENDS = ['start', 'pagehide', 'stop'];

export function computeWindowFeatures(events, windowStart, windowLength) {
  if (!Number.isFinite(windowStart)) throw new RangeError('windowStart must be a finite number');
  if (!(Number.isFinite(windowLength) && windowLength > 0)) {
    throw new RangeError('windowLength must be a finite number greater than 0');
  }
  const end = windowStart + windowLength;
  const sorted = [...events].sort((a, b) => (a.t - b.t) || ((ORDER[a.type] ?? 1) - (ORDER[b.type] ?? 1)));

  const vis = stateTime(sorted, 'visibility', 'visible', windowStart, end);
  const foc = stateTime(sorted, 'focus', 'focus', windowStart, end);
  const act = activity(sorted, windowStart, end);

  return {
    window_start: windowStart,
    window_ms: windowLength,
    state_known_ms: vis.known,
    visible_fraction: vis.known > 0 ? vis.on / vis.known : null,
    focused_fraction: foc.known > 0 ? foc.on / foc.known : null,
    visibility_changes: changes(sorted, 'visibility', windowStart, end),
    focus_changes: changes(sorted, 'focus', windowStart, end),
    activity_known_ms: act.known,
    ...act.rates,
    ms_since_input: msSinceInput(sorted, end),
  };
}

// Time spent in one state, and how much of the window's state is known.
function stateTime(events, type, on, start, end) {
  let state = null;
  let from = start;
  let onMs = 0;
  let knownMs = 0;
  const closeStretch = (until) => {
    const to = Math.min(until, end);
    if (to > from && state !== null) {
      knownMs += to - from;
      if (state === on) onMs += to - from;
    }
    from = Math.max(from, to);
  };
  for (const e of events) {
    if (e.t >= end) break;
    if (e.type !== type && !ENDS.includes(e.type)) continue;
    closeStretch(e.t);
    state = e.type === type ? e.state : null;
  }
  closeStretch(end);
  return { on: onMs, known: knownMs };
}

// Real changes inside the window; a repeat of the same state is not a change.
function changes(events, type, start, end) {
  let state = null;
  let n = 0;
  for (const e of events) {
    if (e.t >= end) break;
    if (ENDS.includes(e.type)) { state = null; continue; }
    if (e.type !== type) continue;
    if (state !== null && e.state !== state && e.t >= start) n += 1;
    state = e.state;
  }
  return n;
}

// Activity per second from the rows that overlap the window.
function activity(events, start, end) {
  let known = 0;
  const sum = {};
  for (const k of KINDS) { sum[`${k}_count`] = 0; sum[`${k}_slots`] = 0; }
  for (const e of events) {
    if (e.type !== 'tick') continue;
    const overlap = Math.min(e.t, end) - Math.max(e.t - e.bucket_ms, start);
    if (overlap <= 0) continue;
    known += overlap;
    const share = overlap / e.bucket_ms;
    for (const field of Object.keys(sum)) sum[field] += e[field] * share;
  }
  const rates = {};
  for (const k of KINDS) {
    rates[`${k}_per_s`] = known > 0 ? sum[`${k}_count`] / (known / 1000) : null;
    rates[`${k}_slots_per_s`] = known > 0 ? sum[`${k}_slots`] / (known / 1000) : null;
  }
  return { known, rates };
}

// Time from the last row with any input to the end of the window.
function msSinceInput(events, end) {
  let last = null;
  for (const e of events) {
    if (e.type === 'tick' && e.t <= end && e.pointer_count + e.touch_count + e.key_count > 0) last = e.t;
  }
  return last === null ? null : end - last;
}
