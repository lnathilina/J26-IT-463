// Runs the exported logistic regression model in the browser.

// The only features a model file may use.
export const MODEL_FEATURES = Object.freeze([
  'visible_fraction', 'visibility_changes', 'focused_fraction', 'focus_changes',
  'pointer_per_s', 'pointer_slots_per_s', 'touch_per_s', 'touch_slots_per_s', 'key_per_s', 'key_slots_per_s',
]);

// Checks a model file and returns a frozen copy, or throws with the reason.
export function loadModel(json) {
  const fail = (why) => { throw new Error(`Model file refused: ${why}`); };
  if (!json || typeof json !== 'object') fail('not an object');
  const { model_version: version, classes, features, mean, scale, coef, intercept, window_ms: windowMs } = json;
  if (typeof version !== 'string' || !version) fail('model_version must be text');
  if (!Array.isArray(classes) || classes.length !== 2 || !classes.every((c) => typeof c === 'string' && c)
    || classes[0] === classes[1]) {
    fail('classes must be two different names');
  }
  if (!Array.isArray(features) || features.length === 0 || !features.every((f) => typeof f === 'string')) {
    fail('features must be a list of names');
  }
  const unknown = features.filter((f) => !MODEL_FEATURES.includes(f));
  if (unknown.length > 0) fail(`not a model feature: ${unknown.join(', ')}`);
  if (new Set(features).size !== features.length) fail('a feature is listed twice');
  for (const [name, list] of [['mean', mean], ['scale', scale], ['coef', coef]]) {
    if (!Array.isArray(list) || list.length !== features.length || !list.every(Number.isFinite)) {
      fail(`${name} must hold one finite number per feature`);
    }
  }
  if (!scale.every((s) => s > 0)) fail('every scale must be above 0');
  if (!Number.isFinite(intercept)) fail('intercept must be a finite number');
  if (!(Number.isFinite(windowMs) && windowMs > 0)) fail('window_ms must be above 0');
  const copy = (list) => Object.freeze([...list]);
  return Object.freeze({ version, classes: copy(classes), features: copy(features), mean: copy(mean),
    scale: copy(scale), coef: copy(coef), intercept, windowMs });
}

// Standardises the features and applies the model; null if a feature is missing.
export function predict(model, features) {
  let logit = model.intercept;
  for (let i = 0; i < model.features.length; i += 1) {
    const x = features[model.features[i]];
    if (!Number.isFinite(x)) return null;
    logit += model.coef[i] * ((x - model.mean[i]) / model.scale[i]);
  }
  const p = 1 / (1 + Math.exp(-logit));
  return { state: logit > 0 ? model.classes[1] : model.classes[0], confidence: Math.max(p, 1 - p), p };
}
