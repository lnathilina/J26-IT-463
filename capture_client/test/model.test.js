// Tests for src/model.js and src/check.js (run from capture_client/ with npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadModel, predict, MODEL_FEATURES } from '../src/model.js';
import { computeWindowFeatures } from '../src/features.js';
import { checkSamples, SAME } from '../src/check.js';

const HAND = {
  model_version: 'hand-1', window_ms: 30000, classes: ['absent', 'present'], features: ['pointer_per_s', 'key_per_s'],
  mean: [1, 2], scale: [2, 4], coef: [3, -1], intercept: 0.5,
};
const x = (P, K) => ({ pointer_per_s: P, key_per_s: K });

test('a hand model: standardise, then logistic regression', () => {
  const m = loadModel(HAND);
  const out = predict(m, x(5, 2));
  assert.equal(out.state, 'present');
  assert.ok(Math.abs(out.p - 1 / (1 + Math.exp(-6.5))) < 1e-15);
  assert.equal(out.confidence, out.p);
  const low = predict(m, x(-3, 2));
  assert.equal(low.state, 'absent');
  assert.ok(Math.abs(low.confidence - (1 - 1 / (1 + Math.exp(5.5)))) < 1e-15);
});

test('a logit of exactly 0 gives classes[0], as scikit-learn predict does', () => {
  const m = loadModel({ ...HAND, intercept: 0, coef: [1, 0] });
  const out = predict(m, x(1, 7));
  assert.deepEqual(out, { state: 'absent', confidence: 0.5, p: 0.5 });
});

test('an unknown feature gives no state', () => {
  const m = loadModel(HAND);
  assert.equal(predict(m, x(5, null)), null);
  assert.equal(predict(m, { pointer_per_s: 5 }), null);
  assert.equal(predict(m, x(NaN, 2)), null);
});

test('a broken model file is refused with the reason', () => {
  const bad = [
    [null, 'not an object'], [{ ...HAND, model_version: '' }, 'model_version'],
    [{ ...HAND, classes: ['a'] }, 'two different names'],
    [{ ...HAND, classes: ['a', 'b', 'c'] }, 'two different names'],
    [{ ...HAND, classes: [1, 2] }, 'two different names'],
    [{ ...HAND, classes: ['', 'present'] }, 'two different names'],
    [{ ...HAND, classes: ['present', 'present'] }, 'two different names'],
    [{ ...HAND, features: [] }, 'list of names'],
    [{ ...HAND, features: ['pointer_per_s', 'ms_since_input'] }, 'not a model feature: ms_since_input'],
    [{ ...HAND, features: ['window_start', 'key_per_s'] }, 'not a model feature: window_start'],
    [{ ...HAND, features: ['key_per_s', 'key_per_s'] }, 'listed twice'],
    [{ ...HAND, coef: [1] }, 'coef must hold one finite number per feature'],
    [{ ...HAND, mean: [1, Infinity] }, 'mean must hold'], [{ ...HAND, scale: [2, 0] }, 'scale must be above 0'],
    [{ ...HAND, intercept: 'x' }, 'intercept'], [{ ...HAND, window_ms: 0 }, 'window_ms'],
  ];
  for (const [json, why] of bad) assert.throws(() => loadModel(json), new RegExp(`refused: .*${why}`), why);
});

test('every one of the 10 model features is accepted (an ablation model uses some)', () => {
  assert.equal(MODEL_FEATURES.length, 10);
  assert.ok(Object.isFrozen(MODEL_FEATURES));
  const n = MODEL_FEATURES.length;
  const all = loadModel({ ...HAND, features: [...MODEL_FEATURES], mean: Array(n).fill(0),
    scale: Array(n).fill(1), coef: Array(n).fill(0) });
  assert.deepEqual(all.features, MODEL_FEATURES);
});

test('the model is frozen all the way down and copies its numbers', () => {
  const json = structuredClone(HAND);
  const m = loadModel(json);
  json.coef[0] = 99;
  json.mean[0] = 99;
  json.classes[1] = 'other';
  assert.deepEqual(m.coef, [3, -1]);
  assert.deepEqual(m.mean, [1, 2]);
  assert.deepEqual(m.classes, ['absent', 'present']);
  assert.ok(Object.isFrozen(m));
  for (const key of ['classes', 'features', 'mean', 'scale', 'coef']) assert.ok(Object.isFrozen(m[key]), key);
  assert.throws(() => { m.coef[0] = 99; }, TypeError);
});

test('browser JS against Python on the 10 sample windows in demo/l1_model.json (D022)', () => {
  const file = JSON.parse(readFileSync(new URL('../demo/l1_model.json', import.meta.url), 'utf8'));
  const m = loadModel(file);
  assert.equal(file.samples.length, 10);
  assert.deepEqual([...new Set(file.samples.filter((s) => s.label).map((s) => s.label))].sort(), ['absent', 'present']);
  assert.ok(file.samples.some((s) => s.features.visibility_changes + s.features.focus_changes > 0));
  for (const [i, s] of file.samples.entries()) {
    const f = computeWindowFeatures(s.events, s.window_start, s.window_ms);
    for (const name of m.features) assert.ok(Math.abs(f[name] - s.features[name]) <= 1e-12, `sample ${i} ${name}`);
    const out = predict(m, f);
    assert.equal(out.state, s.state, `sample ${i} state`);
    assert.ok(Math.abs(out.p - s.p) <= 1e-12, `sample ${i}: JS ${out.p}, Python ${s.p}`);
    assert.ok(Math.abs(out.confidence - s.confidence) <= 1e-12, `sample ${i} confidence`);
  }
});

test('the check the demo button runs (src/check.js) finds each kind of mismatch', () => {
  const file = JSON.parse(readFileSync(new URL('../demo/l1_model.json', import.meta.url), 'utf8'));
  const m = loadModel(file);
  assert.equal(checkSamples(m, file.samples).matched, 10);
  const changed = [
    (s) => { s.confidence += 1e-9; },
    (s) => { s.features.visible_fraction += 1e-9; },
    (s) => { s.p += 1e-9; },
    (s) => { s.state = s.state === 'present' ? 'absent' : 'present'; },
  ];
  for (const [k, change] of changed.entries()) {
    const samples = structuredClone(file.samples);
    change(samples[k]);
    const out = checkSamples(m, samples);
    assert.equal(out.matched, 9, `change ${k}`);
    assert.equal(out.rows[k].match, false, `change ${k}`);
    assert.equal(out.text.startsWith('9 of 10 match'), true);
  }
  assert.equal(SAME, 1e-12);
});
