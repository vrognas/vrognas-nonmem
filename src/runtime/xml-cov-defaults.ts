// Empirically-probed `$COVARIANCE` option defaults for NONMEM 7.6.0
// + tier classifier.
//
// Source: `~/positron-nonmem/probe-cov*/run001.xml` on the host
// (`bare`, `matrix_r`, `matrix_s`, `print_e`, `sir`, `uncond`, `cov_em`).
//
// Single exported entry point: `classifyCovStep(cov, covTokens)`
// returns a `Record<key, CovTier>` where `CovTier ∈ { 'explicit',
// 'explicitDefault', 'implicit' }`. Keys not present render unstyled.
//
// The user's $COV tokens (from .lst echo) are the ground truth for
// "explicit vs implicit":
//   - `explicit`        : user typed this attr on the $COV line.
//   - `explicitDefault` : user typed it AND value matches the baseline.
//   - `implicit`        : user did NOT type it AND value differs from
//                         baseline. Covers $EST inheritance, AUTO-style
//                         implicit setting, and method-default cases.
//   - (default)         : matches baseline + not typed → no entry.

import type { CovarianceOptions } from './parse-xml-problem-options';
import type { EstimationOptionsStep } from './parse-xml-options';
import type { LstTolerances } from './parse-lst-tolerances';

/**
 * Per-key tier in the unified scheme. Omitted from the classifier's
 * output when the key matches the baseline AND user didn't type.
 */
export type CovTier = 'explicit' | 'explicitDefault' | 'implicit';

/**
 * Empirical bare-`$COV` baseline from NM 7.6.0. The 22 attrs always
 * emitted regardless of method or $COV options.
 */
const BARE_COV: Readonly<CovarianceOptions> = {
  atol: '-1',
  cholroff: '0',
  compressed: 'no',
  eigen_print: 'no',
  fposdef: '0',
  knuthsumoff: '-1',
  matrix: 'rsr',
  nofcov: 'no',
  omitted: 'no',
  pfcond: '0',
  posdef: '-1',
  precond: '0',
  preconds: 'tos',
  pretype: '0',
  resume: 'no',
  siglcov: '-1',
  siglocov: '-1',
  sirsample: 'BLANK',
  slow_gradient: 'noslow',
  special: 'no',
  thbnd: '1',
  tol: '-1',
  // Conditionally-emitted by `$COV PRINT=R` / `PRINT=S` — empirically
  // verified at probe-cov-survey/print_r/. Treat default 'no' so a
  // run that DID emit one of these (because user wrote PRINT=R) flags
  // as non-default. When bare $COV: not emitted, so absent from input.
  rmatrix_print: 'no',
  smatrix_print: 'no',
};

/**
 * SIR-block defaults — emitted only when `SIRSAMPLE>0`. Bare $COV does
 * not emit these.
 */
const SIR_BLOCK: Readonly<CovarianceOptions> = {
  capcorr: '1.00000000000000',
  clockseed: '0',
  df: '0.00000000000000',
  file: 'BLANK',
  format: 'BLANK',
  iaccept: '1.00000000000000',
  iacceptl: '0.00000000000000',
  print: '0',
  ranmethod: 'BLANK',
  seed: '11456',
  sircenter: '0',
  sirmaxwt: '1000.00000000000',
  sirminwt: '1.000000000000000E-03',
  sirniter: '1',
  sirthbnd: '1',
};

/**
 * Resolve the empirical baseline for the given options. SIR_BLOCK
 * layers on top of BARE_COV when SIR is actually active, defined as
 * `sirsample` parsing to a positive number (`Number('BLANK')` is NaN,
 * `Number('0')` is 0 — both treated as inactive).
 */
function findCovDefaults(opts: CovarianceOptions): CovarianceOptions {
  const sirActive = Number(opts.sirsample) > 0;
  return sirActive ? { ...BARE_COV, ...SIR_BLOCK } : BARE_COV;
}

/**
 * Resolve a $COV attr's wire value to its runtime-effective value.
 * Returns null when no translation applies (caller displays the wire
 * value as-is).
 *
 * Empirically validated at NM 7.6.0:
 *   - `'-1'` sentinel: inherits from $EST (per Bauer's $COV doc) for
 *     atol/tol/siglcov/siglocov/knuthsumoff. `posdef='-1'` resolves
 *     to method-determined default (0 classical / 3 EM).
 *   - `'BLANK'` sentinel (only emitted when SIR active for SIR-block
 *     attrs): inherits from $EST counterpart for file/format; default
 *     '3' for ranmethod (Bauer's $COV doc says default n=3).
 *
 * `lstTolerances` provides resolved $COV ANRD/NRD from .lst trace
 * (most authoritative source). Fall-through to `lastEst` attrs when
 * trace doesn't carry the value (knuthsumoff, file, format).
 */
/**
 * Map of $COV attr name → patterns matching user $COV tokens that, if
 * present, indicate explicit user setting. Most attrs use the trivial
 * `KEY=` token form (handled via fallback regex); this map covers
 * boolean toggles and aliases.
 */
const COV_ATTR_TO_USER_TOKENS: Readonly<Record<string, ReadonlyArray<RegExp>>> = {
  compressed: [/^COMPRESS$/i],
  eigen_print: [/^PRINT=.*E/i],
  rmatrix_print: [/^PRINT=.*R/i],
  smatrix_print: [/^PRINT=.*S/i],
  special: [/^SPECIAL$/i],
  nofcov: [/^NOFCOV$/i],
  resume: [/^RESUME$/i],
  omitted: [/^OMITTED$/i],
  slow_gradient: [/^SLOW$/i, /^NOSLOW$/i, /^FAST$/i],
  // CONDITIONAL/UNCONDITIONAL — not in XML, but tokens still matter for
  // explicit-tier detection of synthesized rows.
  conditional: [/^N?O?CONDITIONAL$/i, /^UNCONDITIONAL$/i],
};

/**
 * True when the user's $COV tokens indicate an explicit setting of
 * the given $COV attr. When `COV_ATTR_TO_USER_TOKENS` defines aliases
 * for an attr, those are authoritative — we do NOT fall back to the
 * generic `KEY=` regex. Otherwise an attr like `eigen_print` (XML name
 * differs from user token PRINT=E) could false-positive on unrelated
 * tokens via the fallback.
 */
function userWroteCovAttr(attr: string, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false;
  const aliases = COV_ATTR_TO_USER_TOKENS[attr];
  if (aliases) {
    return aliases.some((re) => tokens.some((t) => re.test(t)));
  }
  // No aliases declared — fall back to generic KEY= matching.
  const lowerAttr = attr.toLowerCase();
  return tokens.some((t) => {
    const eq = t.indexOf('=');
    if (eq <= 0) return false;
    return t.slice(0, eq).toLowerCase() === lowerAttr;
  });
}

/**
 * Unified $COV classifier (v0.0.185+). Same explicit/implicit/
 * explicitDefault scheme as `classifyEstStep`. `covTokens` are the
 * user's verbatim tokens from the $COV line in the .lst echo.
 *
 * Differs from the legacy `classifyCovKeys` (kept for back-compat):
 *  - drops the `propagated` yellow tier; propagation collapses into
 *    `implicit` (orange) — value not user-typed AND differs from default
 *  - drops the `userDriven` green tier; user-typed → blue explicit
 */
export function classifyCovStep(
  cov: CovarianceOptions,
  covTokens: readonly string[],
): Record<string, CovTier> {
  const defaults = findCovDefaults(cov);
  const out: Record<string, CovTier> = {};
  for (const k of Object.keys(cov)) {
    const value = cov[k];
    const wroteIt = userWroteCovAttr(k, covTokens);
    const matchesDefault = defaults[k] !== undefined && defaults[k] === value;
    if (wroteIt && matchesDefault) {
      out[k] = 'explicitDefault';
    } else if (wroteIt) {
      out[k] = 'explicit';
    } else if (!matchesDefault) {
      out[k] = 'implicit';
    }
  }
  return out;
}

// NOTE: `methodKind` here is the binary EM-vs-classical discriminator
// used for posdef's '-1' → 0/3 resolution. The JS renderer
// (`client.js:deriveMethodKind`) keeps a more granular 4-way label
// (em/laplace/foce/fo) for INVISIBLE_ATTR_DEFS.applicable gating.
// Both list the same EM-method labels; if NM ships a new EM method,
// update both. Cross-file constant deferred (JS in WebView, TS in
// extension host — no shared bundling target).
export function resolveCovAttrToRuntime(
  key: string,
  value: string,
  lastEst: EstimationOptionsStep | null,
  lstTolerances: LstTolerances | null,
  methodKind: 'em' | 'classical' | null,
): string | null {
  if (value === '-1') {
    // ATOL inherits from $EST → $SUBS → built-in default 12. Trace
    // value is most authoritative; fall back to doc default when
    // the trace block isn't emitted (non-ODE model).
    if (key === 'atol') return lstTolerances?.covAnrd ?? '12';
    if (key === 'tol') return lstTolerances?.covNrd ?? null;
    // SIGL/SIGLO inherit from $EST; doc default is 100 (per nm7/est-
    // options.qmd:116: "If user does not specify SIGL, or sets SIGL=100,
    // then the optimization algorithm will perform the traditional
    // NONMEM VI optimization"). Fall back to '100' when nothing else.
    if (key === 'siglcov') return lstTolerances?.sigl ?? lastEst?.sigl ?? '100';
    if (key === 'siglocov') return lstTolerances?.siglo ?? lastEst?.siglo ?? '100';
    // KNUTHSUMOFF default is 0 per Bauer.
    if (key === 'knuthsumoff') return lastEst?.knuthsumoff ?? '0';
    if (key === 'posdef') {
      // posdef='-1' resolves to 0 (classical) or 3 (EM); when method
      // is unknown, fall back to '0' as the safer default (classical
      // is the most common case).
      if (methodKind === 'em') return '3';
      return '0';
    }
  }
  if (value === 'BLANK') {
    if (key === 'file') return lastEst?.file ?? null;
    if (key === 'format') return lastEst?.format ?? 's1PE12.5';
    if (key === 'ranmethod') return '3';
  }
  return null;
}
