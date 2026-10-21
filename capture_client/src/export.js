// Turns captured events into export records and checks every field against an allow-list.
export const SCHEMA_VERSION = '0.1';
export const ENVELOPE = ['schema_version', 'session_id', 'participant_id', 'source', 'type', 't_ms', 'seq'];
// The only fields each record type may carry.
export const ALLOWED = {
  session_start: ['time_origin_ms', 'wall_ms', 'device_class', 'os_family', 'browser_family', 'browser_major'],
  page_load: ['time_origin_ms', 'wall_ms'],
  page_hide: ['persisted'],
  tick: ['bucket_ms', 'pointer_count', 'pointer_slots', 'touch_count', 'touch_slots', 'key_count', 'key_slots',
    'proc_ms', 'has_focus', 'wall_ms'],
  visibility: ['state', 'initial'],
  focus: ['state', 'initial'],
  session_stop: [],
  probe_schedule: ['method', 'scope', 'start_ms', 'gap_ms', 'block_ms', 'first_block', 'pending_ms', 'answer_ms',
    'upper_ms', 'generator', 'seed_sha256', 'bank_version'],
  probe_fired: ['block', 'mode', 'probe_id', 'fired_t_ms', 'window_seq'],
  probe_shown: ['block', 'mode', 'probe_id'],
  probe_result: ['block', 'mode', 'probe_id', 'outcome', 'chosen', 'response_ms', 'fired_t_ms', 'window_seq', 'reason'],
  probe_seed: ['seed'],
  state: ['window_end_ms', 'window_ms', 'state', 'confidence', 'model_version', 'latency_ms', 'compute_ms'],
};
const SESSION_KEY = 'c1.session';
const PENDING_KEY = 'c1.pending';

// Throws on an unknown type, a missing envelope field or a field not allowed.
export function checkRecord(record) {
  const allowed = ALLOWED[record.type];
  if (!allowed) throw new Error(`Unknown record type: ${record.type}`);
  for (const field of ENVELOPE) {
    if (!(field in record)) throw new Error(`Missing envelope field ${field} in ${record.type}`);
  }
  for (const field of Object.keys(record)) {
    if (!ENVELOPE.includes(field) && !allowed.includes(field)) {
      throw new Error(`Field ${field} is not allowed in ${record.type}`);
    }
  }
  return record;
}

// Coarse device and browser details from the user agent.
export function platformFrom(ua = '', uaData = null) {
  const mobile = uaData?.mobile ?? /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
  const os = /Windows/i.test(ua) ? 'windows'
    : /Android/i.test(ua) ? 'android'
    : /iPhone|iPad|iPod/i.test(ua) ? 'ios'
    : /CrOS/i.test(ua) ? 'chromeos'
    : /Macintosh|Mac OS X/i.test(ua) ? 'macos'
    : /Linux/i.test(ua) ? 'linux'
    : 'other';
  const browsers = [
    ['edge', /Edg(?:e|A|iOS)?\/(\d+)/],
    ['firefox', /(?:Firefox|FxiOS)\/(\d+)/],
    ['chrome', /(?:Chrome|CriOS)\/(\d+)/],
    ['safari', /Version\/(\d+)[^]*Safari/],
  ];
  let browser = ['other', null];
  for (const [name, pattern] of browsers) {
    const m = ua.match(pattern);
    if (m) { browser = [name, Number(m[1])]; break; }
  }
  return { device_class: mobile ? 'mobile' : 'laptop', os_family: os, browser_family: browser[0], browser_major: browser[1] };
}

// Numbers each record and wraps it in the session envelope.
export function createWriter({ sessionId, participantId, timeOrigin, nextSeq = 0, resumed = false, platform }) {
  let seq = nextSeq;
  const envelope = (type, t) => ({
    schema_version: SCHEMA_VERSION, session_id: sessionId, participant_id: participantId,
    source: 'c1', type, t_ms: timeOrigin + t, seq: seq++,
  });
  return {
    get nextSeq() { return seq; },

    fromSignal(e) {
      if (e.type === 'start') {
        const anchor = { time_origin_ms: timeOrigin, wall_ms: e.wall_ms };
        return checkRecord(resumed
          ? { ...envelope('page_load', e.t), ...anchor }
          : { ...envelope('session_start', e.t), ...anchor, ...platform });
      }
      if (e.type === 'stop') return checkRecord(envelope('session_stop', e.t));
      if (e.type === 'pagehide') return checkRecord({ ...envelope('page_hide', e.t), persisted: e.persisted });
      const record = { ...envelope(e.type, e.t), state: e.state };
      if (e.initial) record.initial = true;
      return checkRecord(record);
    },

    fromRow(row, { hasFocus, wallMs }) {
      const { t, ...counts } = row;
      return checkRecord({ ...envelope('tick', t), ...counts, has_focus: hasFocus, wall_ms: wallMs });
    },

    fromProbe(type, t, fields) {
      return checkRecord({ ...envelope(type, t), ...fields });
    },

    fromState(t, { window_end: windowEnd, ...fields }) {
      return checkRecord({ ...envelope('state', t), window_end_ms: timeOrigin + windowEnd, ...fields });
    },
  };
}

// One JSON object per line for one session, in seq order.
export function toJsonLines(records, sessionId) {
  return records
    .filter((r) => r.session_id === sessionId)
    .sort((a, b) => a.seq - b.seq)
    .map((r) => JSON.stringify(r) + '\n')
    .join('');
}

// Continues this tab's session after a reload, or starts a new one.
export function resumeOrStartSession(store, { participantId, newId = () => crypto.randomUUID() }) {
  let error = null;
  try {
    const saved = JSON.parse(store.getItem(SESSION_KEY) ?? 'null');
    if (saved?.session_id) return { ...saved, resumed: true, error };
  } catch (err) {
    error = `Session could not be read (${err?.name ?? 'Error'}); a new session was started.`;
  }
  const session = { session_id: newId(), participant_id: participantId, next_seq: 0 };
  error = saveSession(store, session) ?? error;
  return { ...session, resumed: false, error };
}

export function saveSession(store, { session_id, participant_id, next_seq }) {
  try {
    store.setItem(SESSION_KEY, JSON.stringify({ session_id, participant_id, next_seq }));
    return null;
  } catch (err) {
    return `Session could not be saved (${err?.name ?? 'Error'}); a reload will start a new session.`;
  }
}

// Keeps a record written during pagehide until the next page load.
export function stashRecord(store, record) {
  try {
    const list = JSON.parse(store.getItem(PENDING_KEY) ?? '[]');
    list.push(record);
    store.setItem(PENDING_KEY, JSON.stringify(list));
    return null;
  } catch (err) {
    return `A record could not be kept for the reload (${err?.name ?? 'Error'}).`;
  }
}

export function takeStash(store) {
  try {
    const list = JSON.parse(store.getItem(PENDING_KEY) ?? '[]');
    store.removeItem(PENDING_KEY);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function endSession(store) {
  try { store.removeItem(SESSION_KEY); } catch { }
}
