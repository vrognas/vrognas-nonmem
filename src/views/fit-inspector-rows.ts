// Row-construction helpers for the Fit Inspector payload. Split out
// of `fit-inspector-payload.ts` (was 1300+ LOC) so the row schema +
// all its priority-of-source logic (pickInit → lst → ext fallback,
// OMEGA/SIGMA diag/off-diag merge, prior-map bundling, boundary
// detection, RSE / NUMSIGDIG pairing) sits in one focused module.
//
// Consumers (`fit-inspector-payload.ts`) call:
//   - `buildPriorMaps(model)` once per build to assemble the THETA / OMEGA / SIGMA prior bundle
//   - `buildThetaRow(t, fit, ...)` per THETA decl
//   - `mergeMatrixRows(prefix, diagonals, fit, ...)` per OMEGA / SIGMA section
//   - `pairNumSigDig(lst, fit)` once per build to feed all three sections
//   - `filterByExtColumns(decls, fit, toKey)` once per kind to drop phantom decls
//
// Type-only: `InspectorRow` lives in `fit-inspector-payload.ts` because
// it's part of the wire payload — these helpers just produce values of
// that shape.

import type { NmtranParsedModel } from '../nmtran-client';
import type { ExtEstimates } from '../runtime/parse-ext-fit';
import type { LstSummary } from '../runtime/parse-lst';
import type { InspectorRow } from './fit-inspector-payload';

/**
 * NMTRAN prior-decl source shape on `NmtranParsedModel`. Each entry is
 * a 1-based index → value pair (`$THETAP`, `$OMEGAP`, etc).
 */
type PriorDecl = { index: number; value: number };

/** Per-block prior bundle for OMEGA / SIGMA rows (mode + degrees of freedom). */
export interface MatrixPriorMaps {
  /** Prior mode by 1-based diagonal index (from `$OMEGAP` / `$SIGMAP`). */
  p: ReadonlyMap<number, number>;
  /** Degrees of freedom by 1-based diagonal index (from `$OMEGAPD` / `$SIGMAPD`). */
  df: ReadonlyMap<number, number>;
}

/** Per-block prior bundle for THETA rows (mean + variance). */
export interface ThetaPriorMaps {
  /** Prior mean by 1-based theta index (from `$THETAP`). */
  p: ReadonlyMap<number, number>;
  /** Prior variance by 1-based theta index (from `$THETAPV`). */
  pv: ReadonlyMap<number, number>;
}

/**
 * Build the per-kind prior-lookup bundle. One pass through each of the
 * 6 source arrays on `model`; callers carry one object instead of six
 * standalone maps.
 */
export function buildPriorMaps(model: NmtranParsedModel): {
  theta: ThetaPriorMaps;
  omega: MatrixPriorMaps;
  sigma: MatrixPriorMaps;
} {
  return {
    theta: {
      p: priorIndexMap(model.thetaPriors),
      pv: priorIndexMap(model.thetaPriorVariances),
    },
    omega: {
      p: priorIndexMap(model.omegaPriors),
      df: priorIndexMap(model.omegaPriorDfs),
    },
    sigma: {
      p: priorIndexMap(model.sigmaPriors),
      df: priorIndexMap(model.sigmaPriorDfs),
    },
  };
}

/**
 * Pick the init value to display, preferring vscode-nmtran's parsed
 * model value when finite, falling back to the `.ext` iteration-0 row.
 * vscode-nmtran has been observed returning null / undefined / NaN
 * for some bare-form `$THETA 1` and `$OMEGA 0.1` declarations; the
 * `.ext` iteration-0 row holds the same value NONMEM actually used,
 * so it's the right fallback. mod-mode (no fit) returns null when the
 * model value isn't finite — there's nothing to fall back to.
 *
 * The `implicit` flag is true when the fallback path took effect AND
 * .ext supplied a value — the client uses it to render muted-with-tooltip
 * so the user knows the value is .ext-sourced rather than model-sourced.
 * For the empty-init `$THETA (-1, , 1)` form NONMEM computes the
 * midpoint at iteration 0; that finite midpoint is what `fit.inits`
 * holds and what the user sees, but we still want to flag it as
 * "not from the .mod text" — without the flag the muted indicator
 * wouldn't fire (since `r.init` is now a finite number).
 */
export function pickInit(
  modelValue: number | null | undefined,
  name: string,
  fit: ExtEstimates | null,
  lstInitial?: Map<string, number>,
): { value: number | null; implicit: boolean } {
  if (typeof modelValue === 'number' && Number.isFinite(modelValue)) {
    return { value: modelValue, implicit: false };
  }
  // Second tier: NONMEM's `0INITIAL ESTIMATE OF` echo in the .lst.
  // Authoritative (it's the user's $OMEGA / $SIGMA verbatim, NM-parsed)
  // — so NOT marked implicit. Distinct from the .ext fallback below
  // which for SAEM is NONMEM's perturbed runtime starting matrix, not
  // the user's intent.
  const fromLst = lstInitial?.get(name);
  if (typeof fromLst === 'number' && Number.isFinite(fromLst)) {
    return { value: fromLst, implicit: false };
  }
  const fromExt = fit?.inits.get(name);
  if (typeof fromExt === 'number' && Number.isFinite(fromExt)) {
    return { value: fromExt, implicit: true };
  }
  return { value: null, implicit: false };
}

/**
 * In lst-mode (fit present), drop any decl entries whose access-key
 * isn't a column in the `.ext` finals — `.ext` is authoritative for
 * how many parameters the run actually has, and the parser
 * occasionally returns phantom extras for some `$THETA` / `$OMEGA`
 * forms. In mod-mode (no fit), pass through unchanged — there's no
 * authoritative source to filter against.
 */
export function filterByExtColumns<T>(
  decls: T[],
  fit: ExtEstimates | null,
  toKey: (d: T) => string,
): T[] {
  if (!fit) return decls;
  return decls.filter((d) => fit.finals.has(toKey(d)));
}

/**
 * Pair LstSummary's `numSigDigPerParam` (positional array, .ext-column
 * order) with the access keys from `fit.finals` (insertion-ordered to
 * match the .ext header). Returns an empty Map when either source is
 * absent — callers degrade gracefully (no NUMSIGDIG cells).
 */
export function pairNumSigDig(
  lst: LstSummary | null | undefined,
  fit: ExtEstimates | null,
): Map<string, number> {
  if (!lst || !fit || lst.numSigDigPerParam.length === 0) return new Map();
  const out = new Map<string, number>();
  const names = [...fit.finals.keys()];
  const n = Math.min(names.length, lst.numSigDigPerParam.length);
  for (let i = 0; i < n; i++) out.set(names[i], lst.numSigDigPerParam[i]);
  return out;
}

/**
 * Build a single THETA row. Lifted out of the inline `filteredThetas.map`
 * in `buildInspectorPayload` so the row schema is in one place. Theta
 * has no stdcorr propagation (the SD/correlation transform is OMEGA /
 * SIGMA only — for THETA the stdcorr row would be identical to the
 * variance-form row and the client never reads it).
 */
export function buildThetaRow(
  t: { index: number; init: number; lower?: number | null; upper?: number | null; fix: boolean; line?: number; comment?: string },
  fit: ExtEstimates | null,
  numSigDigByName: Map<string, number>,
  label: string | null,
  priors: ThetaPriorMaps,
): InspectorRow {
  const name = `THETA(${t.index})`;
  const final = fit?.finals.get(name) ?? null;
  const se = fit?.standardErrors.get(name) ?? null;
  const initPick = pickInit(t.init, name, fit);
  return {
    index: t.index,
    name,
    label,
    lower: t.lower ?? null,
    init: initPick.value,
    impliedInit: initPick.implicit,
    upper: t.upper ?? null,
    final,
    finalStdcorr: null,
    se,
    seStdcorr: null,
    rse: computeRse('theta', final, se),
    rseStdcorr: null,
    // .ext `-1000000006` is authoritative when present (NONMEM-direct);
    // fall back to vscode-nmtran's parsed-model `t.fix` flag otherwise.
    fixed: fit?.fixedFlags.get(name) ?? t.fix,
    numSigDig: numSigDigByName.get(name) ?? null,
    declLine: t.line ?? null,
    boundary: computeBoundary(final, t.lower ?? null, t.upper ?? null, t.fix, true),
    priorValue: priors.p.get(t.index) ?? null,
    priorVariance: priors.pv.get(t.index) ?? null,
    priorDf: null,
  };
}

/**
 * Combine diagonal entries (from vscode-nmtran's parsed model) with
 * off-diagonal BLOCK matrix elements (from the `.ext` fit overlay)
 * into a single lower-triangular-sorted row list. Off-diagonal rows
 * have no init from the .mod source — vscode-nmtran's API doesn't
 * expose BLOCK matrix elements today, so they only appear when the
 * run has actually been executed (.ext exists).
 */
export function mergeMatrixRows(
  prefix: 'OMEGA' | 'SIGMA',
  diagonals: { index: number; value: number; fix: boolean; line?: number; comment?: string }[],
  fit: ExtEstimates | null,
  numSigDigByName: Map<string, number>,
  lstInitial: Map<string, number>,
  labels: ReadonlyMap<number, string>,
  priors: MatrixPriorMaps,
): InspectorRow[] {
  const rows = diagonals.map((d) =>
    buildOmegaSigmaDiagRow(d, prefix, fit, numSigDigByName, lstInitial, labels, priors),
  );
  if (fit) rows.push(...offDiagonalRows(prefix, fit, numSigDigByName, lstInitial));
  rows.sort(compareMatrixRows);
  return rows;
}

function buildOmegaSigmaDiagRow(
  d: { index: number; value: number; fix: boolean; line?: number; comment?: string },
  prefix: 'OMEGA' | 'SIGMA',
  fit: ExtEstimates | null,
  numSigDigByName: Map<string, number>,
  lstInitial: Map<string, number>,
  labels: ReadonlyMap<number, string>,
  priors: MatrixPriorMaps,
): InspectorRow {
  const name = `${prefix}(${d.index},${d.index})`;
  const initPick = pickInit(d.value, name, fit, lstInitial);
  return makeOmegaSigmaRow({
    index: d.index,
    name,
    label: labels.get(d.index) ?? d.comment ?? null,
    init: initPick.value,
    impliedInit: initPick.implicit,
    fix: d.fix,
    line: d.line ?? null,
    fit,
    numSigDigByName,
    priorValue: priors.p.get(d.index) ?? null,
    priorDf: priors.df.get(d.index) ?? null,
  });
}

function offDiagonalRows(
  prefix: 'OMEGA' | 'SIGMA',
  fit: ExtEstimates,
  numSigDigByName: Map<string, number>,
  lstInitial: Map<string, number>,
): InspectorRow[] {
  const rows: InspectorRow[] = [];
  for (const [name] of fit.finals) {
    const idx = parseMatrixIndex(name);
    if (!idx || !name.startsWith(prefix) || idx.row === idx.col) continue;
    // Off-diagonals have no .mod source for the init — `pickInit` with
    // `modelValue: undefined` falls through its lst → ext priority
    // tiers (same as diagonals) so both paths share one set of fallback
    // rules instead of two implementations drifting apart.
    const initPick = pickInit(undefined, name, fit, lstInitial);
    rows.push(
      makeOmegaSigmaRow({
        index: idx.row,
        name,
        // No .mod source for off-diagonals -> no inline comment label.
        label: null,
        init: initPick.value,
        impliedInit: initPick.implicit,
        // Off-diagonal FIX-flag inheritance from `$OMEGA BLOCK ... FIX`
        // isn't recoverable from .lst echo (the FIXED column is per-block,
        // not per-element); keep `false` until we parse it explicitly.
        fix: false,
        line: null,
        fit,
        numSigDigByName,
        // Priors are diagonal-only by construction; off-diagonals get null.
        priorValue: null,
        priorDf: null,
      }),
    );
  }
  return rows;
}

/**
 * Single source of truth for OMEGA / SIGMA row construction. Both
 * the diagonal path (init from vscode-nmtran's parsed model) and the
 * off-diagonal path (init from `.ext` iteration-0) feed through here
 * so the row schema (lower/upper omitted, final/se/rse paired,
 * NUMSIGDIG looked up by name) stays consistent.
 *
 * vscode-nmtran's `NmtranOmegaSigmaDecl` doesn't expose `$OMEGA (lb, ie,
 * ub)` bounds, so `lower`/`upper` always render as `—` for OMEGA / SIGMA.
 * When that lands upstream, plumb the values through the `init` arg's
 * caller and add `lower`/`upper` to this helper's args.
 */
function makeOmegaSigmaRow(args: {
  index: number;
  name: string;
  /** Inline-comment label for diagonals (from .mod); null for off-diagonals (no .mod source). */
  label: string | null;
  init: number | null;
  impliedInit: boolean;
  fix: boolean;
  line: number | null;
  fit: ExtEstimates | null;
  numSigDigByName: Map<string, number>;
  /** Prior MODE for the diagonal of this row (from $OMEGAP / $SIGMAP). Null for off-diagonals + when no prior record. */
  priorValue: number | null;
  /** Degrees of freedom for the prior (from $OMEGAPD / $SIGMAPD, expanded per-row). Null for off-diagonals + when no prior record. */
  priorDf: number | null;
}): InspectorRow {
  const final = args.fit?.finals.get(args.name) ?? null;
  const se = args.fit?.standardErrors.get(args.name) ?? null;
  const finalStdcorr = args.fit?.finalsStdcorr.get(args.name) ?? null;
  const seStdcorr = args.fit?.standardErrorsStdcorr.get(args.name) ?? null;
  return {
    index: args.index,
    name: args.name,
    label: args.label,
    lower: null,
    init: args.init,
    impliedInit: args.impliedInit,
    upper: null,
    final,
    finalStdcorr,
    se,
    seStdcorr,
    rse: computeRse('matrix', final, se),
    rseStdcorr: computeRseStdcorr(finalStdcorr, seStdcorr),
    // Prefer .ext `-1000000006` flag over the diagonal-only .mod-parsed
    // value: the .ext flag covers BLOCK matrix off-diagonals too (.mod
    // path always passes false for those — see `offDiagonalRows`).
    fixed: args.fit?.fixedFlags.get(args.name) ?? args.fix,
    numSigDig: args.numSigDigByName.get(args.name) ?? null,
    declLine: args.line,
    // OMEGA/SIGMA bounds aren't exposed by vscode-nmtran today; with
    // both sides null, computeBoundary always returns null. Threaded
    // through anyway so the field is uniform across all rows and so
    // future bound-aware data lands in the right place.
    boundary: computeBoundary(final, null, null, args.fix),
    priorValue: args.priorValue,
    priorVariance: null,
    priorDf: args.priorDf,
  };
}

/**
 * RSE on the SD/correlation scale, computed directly from NONMEM's
 * `-1000000004` and `-1000000005` rows. No `/2` factor because the
 * propagation has already happened upstream — `seStdcorr` IS the SE on
 * the SD scale, not the variance-form SE.
 */
function computeRseStdcorr(final: number | null, se: number | null): number | null {
  if (final === null || se === null || se === 0 || final === 0) return null;
  return se / Math.abs(final);
}

/**
 * Relative SE matching PsN sumo's default `sd_rse=1` rendering. Sumo
 * source: `bin/sumo` lines 800-840 (v5.3.1) — for OMEGA / SIGMA the
 * column shown is `cvse / 2` where `cvse = SE / |estimate|`. The
 * footer note in sumo's own output explains:
 *   "The relative standard errors for omega and sigma are reported on
 *    the approximate standard deviation scale (SE/variance estimate)/2."
 * Off-diagonal OMEGA(i,j) entries follow the same /2 rule (sumo
 * doesn't special-case covariances). Caller passes `kind` so we don't
 * regex-sniff names.
 */
function computeRse(
  kind: 'theta' | 'matrix',
  final: number | null,
  se: number | null,
): number | null {
  // NONMEM emits SE=0 for parameters that COV didn't infer — typically
  // FIXED params (no inference attempted) but also some boundary or
  // unidentifiable cases. Treating that as a valid 0% RSE is wrong:
  // 0% reads as "infinitely precise" when the truth is "no inference".
  // parseExtFit already drops the entire SE row when ALL values are
  // zero ($COV step skipped/failed); this guard handles the per-param
  // case where the row is mixed.
  if (final === null || se === null || se === 0 || final === 0) return null;
  const factor = kind === 'matrix' ? 0.5 : 1;
  return (se / Math.abs(final)) * factor;
}

/** Lower-triangular row-major: sort by row index, then column index. */
function compareMatrixRows(a: InspectorRow, b: InspectorRow): number {
  const ai = parseMatrixIndex(a.name);
  const bi = parseMatrixIndex(b.name);
  if (!ai || !bi) return 0;
  return ai.row !== bi.row ? ai.row - bi.row : ai.col - bi.col;
}

function parseMatrixIndex(name: string): { row: number; col: number } | null {
  const m = name.match(/\((\d+),(\d+)\)$/);
  return m ? { row: Number(m[1]), col: Number(m[2]) } : null;
}

/**
 * Build a 1-based-index → value lookup from a `NmtranPriorDecl[]`. Used
 * by `buildPriorMaps` to attach prior P / PV / PD to each parameter row.
 * Empty map when the source array is undefined (older vscode-nmtran) or
 * empty (no prior records in the model).
 */
function priorIndexMap(priors: PriorDecl[] | undefined): Map<number, number> {
  const out = new Map<number, number>();
  if (!priors) return out;
  for (const p of priors) out.set(p.index, p.value);
  return out;
}

/**
 * Detect at-boundary parameters for the orange highlight. The user-facing
 * hazard is "estimator stuck against the bound" — a parameter that ran into
 * its `(lb, ie, ub)` constraint rather than converging freely. FIX rows are
 * intentionally exempt: they sit at "their bound" by design (NONMEM doesn't
 * even estimate them), so flagging them as a problem is noise.
 *
 * For THETA, when the user omits a bound NONMEM uses ±1e+06 sentinels
 * internally (verified empirically — run010.lst echoes ±0.1000E+07 in
 * the INITIAL ESTIMATE block). Strict equality against null lower/upper
 * skipped that case; we now compare against the implicit sentinels too,
 * matching the muted-bound display in the inspector cell.
 *
 * Strict equality (`===`) suffices because NONMEM rounds boundary-active
 * estimates to the bound itself; no epsilon needed.
 */
const THETA_IMPLICIT_LOWER = -1e6;
const THETA_IMPLICIT_UPPER = 1e6;

function computeBoundary(
  final: number | null,
  lower: number | null,
  upper: number | null,
  fix: boolean,
  isTheta: boolean = false,
): 'lower' | 'upper' | null {
  if (fix || final === null) return null;
  const lb = lower ?? (isTheta ? THETA_IMPLICIT_LOWER : null);
  const ub = upper ?? (isTheta ? THETA_IMPLICIT_UPPER : null);
  if (lb !== null && final === lb) return 'lower';
  if (ub !== null && final === ub) return 'upper';
  return null;
}
