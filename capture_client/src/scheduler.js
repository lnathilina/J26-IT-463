// Draws random probe times and the question order from a per-session seed.

// Minimum gap, block length, first block, session limit, waiting time and answer limit; times in ms.
export const DEFAULTS = {
  gapMs: 5 * 60 * 1000,
  blockMs: 10 * 60 * 1000,
  firstBlock: 1,
  upperMs: 3 * 60 * 60 * 1000,
  pendingMs: 2 * 60 * 1000,
  answerMs: 15 * 1000,
};
export const GENERATOR = 'sfc32-v1';

// 128 random bits as 32 hex characters.
export function makeSeed(random = (a) => globalThis.crypto.getRandomValues(a)) {
  return [...random(new Uint32Array(4))].map((w) => w.toString(16).padStart(8, '0')).join('');
}

// SHA-256 of the seed, logged when the session starts.
export async function seedHash(seed) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function checkOptions(o) {
  if (!(o.gapMs > 0)) throw new RangeError('gapMs must be above 0');
  if (!(o.blockMs >= o.gapMs)) throw new RangeError('blockMs must be at least gapMs');
  if (!(o.pendingMs + o.answerMs < o.gapMs)) throw new RangeError('pendingMs + answerMs must be below gapMs (one probe at a time)');
  if (!(Number.isInteger(o.firstBlock) && o.firstBlock >= 0)) throw new RangeError('firstBlock must be a whole number, 0 or more');
  if (!(o.upperMs >= o.blockMs)) throw new RangeError('upperMs must be at least one block');
}

// One probe per block, at least half a gap from each block edge.
export function buildSchedule(seed, options = {}) {
  const o = { ...DEFAULTS, ...options };
  checkOptions(o);
  const next = generator(seedWords(seed, 0));
  const probes = [];
  for (let k = o.firstBlock; (k + 1) * o.blockMs <= o.upperMs; k += 1) {
    const low = k * o.blockMs + o.gapMs / 2;
    const high = (k + 1) * o.blockMs - o.gapMs / 2;
    probes.push({ block: k, offsetMs: low + next() * (high - low) });
  }
  return probes;
}

// A fixed, seed-based shuffle of a segment's questions.
export function itemOrder(seed, segmentId, n) {
  const next = generator(seedWords(seed, fnv1a(String(segmentId))));
  const order = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

// The question for a block: the next unused one in its segment's order.
export function itemFor(seed, schedule, block, segmentAt) {
  const probe = schedule.find((p) => p.block === block);
  const segment = segmentAt(probe.offsetMs);
  const j = schedule.filter((p) => p.block < block && segmentAt(p.offsetMs).id === segment.id).length;
  const order = itemOrder(seed, segment.id, segment.items.length);
  return { segmentId: segment.id, item: j < order.length ? segment.items[order[j]] : null };
}

function seedWords(seed, salt) {
  if (!/^[0-9a-f]{32}$/.test(seed)) throw new RangeError('seed must be 32 lower-case hex characters');
  return [0, 8, 16, 24].map((i) => (parseInt(seed.slice(i, i + 8), 16) ^ salt) >>> 0);
}

// sfc32 pseudo-random generator.
function generator([a, b, c, d]) {
  const next = () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i += 1) next();
  return next;
}

// Small string hash used to vary the seed per segment.
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
