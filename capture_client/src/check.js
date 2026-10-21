// Checks the browser code against Python on the model file's sample windows.
import { computeWindowFeatures } from './features.js';
import { predict } from './model.js';

// Two float sums in a different order can differ in the last digits.
export const SAME = 1e-12;

export function checkSamples(model, samples) {
  const rows = samples.map((s) => {
    const f = computeWindowFeatures(s.events, s.window_start, s.window_ms);
    const out = predict(model, f);
    const row = {
      features: model.features.every((name) => Math.abs(f[name] - s.features[name]) <= SAME),
      state: out?.state === s.state,
      pDiff: Math.abs((out?.p ?? Infinity) - s.p),
      confidence: Math.abs((out?.confidence ?? Infinity) - s.confidence) <= SAME,
    };
    row.match = row.features && row.state && row.pDiff <= SAME && row.confidence;
    return row;
  });
  const matched = rows.filter((r) => r.match).length;
  const maxPDiff = Math.max(...rows.map((r) => r.pDiff));
  return { matched, total: rows.length, maxPDiff, rows,
    text: `${matched} of ${rows.length} match (largest probability difference ${maxPDiff.toExponential(1)})` };
}
