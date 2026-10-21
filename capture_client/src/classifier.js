// Runs the model on each window of activity and emits a state every few seconds.
import { computeWindowFeatures } from './features.js';
import { predict } from './model.js';

export function createClassifier({ model, hopMs = 5000, now, emit }) {
  if (!(Number.isFinite(hopMs) && hopMs > 0)) throw new RangeError('hopMs must be above 0');
  let states = [];
  let ticks = [];
  let nextEnd = null;
  let skipped = 0;
  return {
    noteEvent(e) {
      states.push(e);
      if (e.type === 'start' && nextEnd === null) nextEnd = e.t + model.windowMs;
    },
    // Closes each window this row reaches, skipping ones that ended while the page was frozen.
    noteRow(row) {
      ticks.push({ type: 'tick', ...row });
      const rowStart = row.t - row.bucket_ms;
      while (nextEnd !== null && row.t >= nextEnd) {
        const end = nextEnd;
        nextEnd += hopMs;
        if (end <= rowStart) { skipped += 1; continue; }
        const t0 = now();
        const out = predict(model, computeWindowFeatures(states.concat(ticks), end - model.windowMs, model.windowMs));
        const t1 = now();
        emit({ t: t1, window_end: end, window_ms: model.windowMs, state: out?.state ?? null,
          confidence: out?.confidence ?? null, model_version: model.version, latency_ms: t1 - end, compute_ms: t1 - t0 });
      }
      if (nextEnd !== null) ticks = ticks.filter((r) => r.t > nextEnd - model.windowMs);
    },
    get nextEnd() { return nextEnd; },
    get skipped() { return skipped; },
    get keptTicks() { return ticks.length; },
  };
}
