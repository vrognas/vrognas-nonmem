// transforms.js — value transforms and matrix-name helpers for the
// Fit Inspector. Pure functions where possible (no DOM, no globals)
// so they're testable in isolation. Loaded BEFORE `client.js` via
// the inspector HTML; functions are top-level globals (no module
// loaders, same model as `client.js` and `formatters.js`).
//
// Two helpers DO read globals (`prefs`, `lastPayload`):
//   - `collectEtaShrinkages` / `collectEpsShrinkages` (need diagnostics + toggle state)
// The rest take state-as-arg explicitly.

/**
 * Detect a diagonal OMEGA/SIGMA matrix entry from its access key:
 *   - OMEGA(1,1) → diagonal (1 === 1)
 *   - OMEGA(2,1) → off-diagonal (2 ≠ 1)
 * Returns false for non-matrix names (e.g. THETA(1)).
 */
function matrixIsDiagonal(name) {
  const m = name.match(/\((\d+),(\d+)\)$/);
  return !!m && m[1] === m[2];
}

/**
 * Build `i -> diagonal variance` lookup for the current OMEGA / SIGMA
 * section. Used by the `√Ω/ρ` toggle to compute correlations for off-
 * diagonals: `cov(i,j) / √(var_i · var_j)`. Uses `final` in lst-mode
 * and `init` in mod-mode so the toggle behaves the same in both.
 * Returns an empty Map when no rows match — `transformValue` then
 * falls back to the raw value.
 */
function buildDiagBaseValues(rows, hasFit) {
  const out = new Map();
  for (const r of rows) {
    const m = r.name.match(/\((\d+),(\d+)\)$/);
    if (!m || m[1] !== m[2]) continue;
    const v = hasFit ? r.final : r.init;
    if (typeof v === 'number' && isFinite(v)) out.set(Number(m[1]), v);
  }
  return out;
}

/**
 * Apply the active display preferences to a parameter value:
 *   - `exp(θ)` toggle on a THETA: `Math.exp(v)`. Useful when THETA is
 *      defined on the log scale.
 *   - `√Ω/ρ` toggle on an OMEGA / SIGMA:
 *      - diagonal `(i,i)` → `sqrt(v)` = SD scale (negative variance →
 *        null; sqrt is undefined and rendering raw would be misleading)
 *      - off-diagonal `(i,j)` → `v / sqrt(diag_i · diag_j)` = correlation
 *        (off-diagonal alone has no SD form; needs both diagonals).
 *        Falls back to null when either diagonal is missing/zero/negative
 *        rather than producing a half-transformed grid.
 *
 * Pure given (v, kind, name, diagBaseValues, prefs). The legacy
 * `prefs` global is passed as an arg so the function is unit-testable.
 */
function transformValue(v, kind, name, diagBaseValues, prefsArg) {
  // Default to the global `prefs` for production callers; tests pass
  // an explicit object. Keeps the call-site footprint identical.
  const p = prefsArg ?? (typeof prefs !== 'undefined' ? prefs : { sqrtOm: false, expTh: false });
  if (typeof v !== 'number' || !isFinite(v)) return null;
  if (kind === 'theta' && p.expTh) return Math.exp(v);
  if ((kind === 'omega' || kind === 'sigma') && p.sqrtOm) {
    const m = name && name.match(/\((\d+),(\d+)\)$/);
    if (!m) return v;
    const i = Number(m[1]);
    const j = Number(m[2]);
    if (i === j) return v >= 0 ? Math.sqrt(v) : null;
    const di = diagBaseValues && diagBaseValues.get(i);
    const dj = diagBaseValues && diagBaseValues.get(j);
    if (typeof di === 'number' && typeof dj === 'number' && di > 0 && dj > 0) {
      return v / Math.sqrt(di * dj);
    }
    return null;
  }
  return v;
}

/**
 * Pick the right shrinkage source for the per-row [Shrinkage%] cells.
 * `√Ω/ρ` toggle ON → SD-scale; OFF → variance-scale (with SD-scale
 * fallback when variance arrays are empty — older NONMEM emits one
 * but not the other).
 *
 * Reads the `lastPayload` and `prefs` globals (set by `client.js` on
 * each render). Tests can stub by setting those globals before calling.
 */
function collectEtaShrinkages() {
  const d = lastPayload && lastPayload.diagnostics;
  if (!d) return [];
  if (prefs.sqrtOm) return d.etaShrinkSd.length ? d.etaShrinkSd : [];
  return d.etaShrinkVr.length ? d.etaShrinkVr : d.etaShrinkSd;
}

function collectEpsShrinkages() {
  const d = lastPayload && lastPayload.diagnostics;
  if (!d) return [];
  if (prefs.sqrtOm) return d.epsShrinkSd.length ? d.epsShrinkSd : [];
  return d.epsShrinkVr.length ? d.epsShrinkVr : d.epsShrinkSd;
}

// Dual-mode export: WebView ignores (`module` is undefined in browsers,
// guard prevents ReferenceError); Node / vitest sees the exports for
// unit testing. Same pattern works for any future testable WebView-side
// helper file.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { matrixIsDiagonal, buildDiagBaseValues, transformValue };
}
