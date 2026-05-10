// Empirically-probed `$COVARIANCE` option defaults for NONMEM 7.6.0
// + tier classifier.
//
// Source: `~/positron-nonmem/probe-cov*/run001.xml` on the host
// (`bare`, `matrix_r`, `matrix_s`, `print_e`, `sir`, `uncond`, `cov_em`).
//
// Single exported entry point: `classifyCovKeys(cov, lastEst)` returns
// a `Record<key, tier>` where tier ∈ `{ 'nonDefault', 'propagated',
// 'userDriven' }`. Keys not present in the result render as default
// (no highlight). Tier resolution order, encoded in one pass:
//
//   1. PROPAGATED (yellow): `-1` value AND key in PROPAGATED_KEYS AND
//      the corresponding $EST sibling is itself non-default. We
//      cross-reference the last $EST step because $COV inherits from
//      $EST when the user didn't set the option. If $EST is also at
//      default, propagation is meaningless ("look at $EST" — nothing
//      to look at) and we render normal.
//   2. USER_DRIVEN (green): key in USER_DRIVEN_KEYS AND value differs
//      from the baseline default (i.e. user actually set it). The
//      sentinel `'BLANK'` for sirsample/file/format is the not-set
//      default and renders normal — green would imply "you typed this".
//   3. NON_DEFAULT (blue): value differs from the baseline.
//   4. (default): no entry in the result.

import type { CovarianceOptions } from './parse-xml-problem-options';
import type { EstimationOptionsStep } from './parse-xml-options';
import type { LstTolerances } from './parse-lst-tolerances';
import { findNonDefaultKeys } from './xml-est-defaults';

/** Per-key tier, omitted when the key matches default. */
export type CovKeyTier = 'nonDefault' | 'propagated' | 'userDriven';

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
 * `cov_*` keys → corresponding `$EST` knob name. Only keys that
 * inherit from `$EST` — `cov_tol` chains through `$SUBROUTINES`
 * directly (skipping $EST), so we can't cross-reference; it's omitted
 * here and renders normal when `-1`. `cov_posdef` is method-determined
 * (0 classical / 3 EM), also not propagation; same treatment.
 */
const PROPAGATION_SOURCES: ReadonlyMap<string, string> = new Map([
  ['atol', 'atol'],
  ['siglcov', 'sigl'],
  ['siglocov', 'siglo'],
  ['knuthsumoff', 'knuthsumoff'],
]);

/**
 * Keys NM requires the user to set, OR per-run identities (seed paths,
 * file, format strings). Rendered green only when the value DIFFERS
 * from the baseline — `sirsample='BLANK'` and `seed='11456'` are
 * defaults, not user-set, so they render normal.
 */
const USER_DRIVEN_KEYS: ReadonlySet<string> = new Set([
  'sirsample',
  'sirniter',
  'seed',
  'clockseed',
  'file',
  'format',
]);

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
 * Single-pass classifier. Disjoint tiers, encoded precedence (most
 * specific first). See module-level comment for the full rule set.
 */
export function classifyCovKeys(
  cov: CovarianceOptions,
  lastEst: EstimationOptionsStep | null,
): Record<string, CovKeyTier> {
  const defaults = findCovDefaults(cov);
  const estNonDefaults = lastEst
    ? new Set<string>(findNonDefaultKeys(lastEst))
    : new Set<string>();
  const out: Record<string, CovKeyTier> = {};
  for (const k of Object.keys(cov)) {
    const value = cov[k];
    // 1. Propagated: -1 sentinel, key has an $EST sibling, that sibling
    //    is non-default. Otherwise (sibling at default or no $EST data)
    //    → effective default → no entry.
    if (value === '-1' && PROPAGATION_SOURCES.has(k)) {
      const estKey = PROPAGATION_SOURCES.get(k);
      if (estKey && estNonDefaults.has(estKey)) {
        out[k] = 'propagated';
      }
      continue;
    }
    // 2. User-driven: only when value actually differs from baseline.
    //    `sirsample='BLANK'` matches baseline → not user-driven.
    if (USER_DRIVEN_KEYS.has(k)) {
      if (defaults[k] !== value) {
        out[k] = 'userDriven';
      }
      continue;
    }
    // 3. Non-default: any other key whose value differs from baseline.
    if (defaults[k] !== value) {
      out[k] = 'nonDefault';
    }
  }
  return out;
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
export function resolveCovAttrToRuntime(
  key: string,
  value: string,
  lastEst: EstimationOptionsStep | null,
  lstTolerances: LstTolerances | null,
  methodKind: 'em' | 'classical' | null,
): string | null {
  if (value === '-1') {
    if (key === 'atol') return lstTolerances?.covAnrd ?? null;
    if (key === 'tol') return lstTolerances?.covNrd ?? null;
    if (key === 'siglcov') return lstTolerances?.sigl ?? lastEst?.sigl ?? null;
    if (key === 'siglocov') return lstTolerances?.siglo ?? lastEst?.siglo ?? null;
    if (key === 'knuthsumoff') return lastEst?.knuthsumoff ?? null;
    if (key === 'posdef') {
      if (methodKind === 'em') return '3';
      if (methodKind === 'classical') return '0';
      return null;
    }
  }
  if (value === 'BLANK') {
    if (key === 'file') return lastEst?.file ?? null;
    if (key === 'format') return lastEst?.format ?? null;
    // RANMETHOD default per Bauer $COV doc: `n=3` (uniform PRNG).
    if (key === 'ranmethod') return '3';
  }
  return null;
}
