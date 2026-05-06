// Pure payload builder for the Fit Inspector WebView. Maps a
// vscode-nmtran parsed model (declarations) + an optional `.ext` fit
// overlay into a flat per-parameter row set the WebView can render
// without any further data-shape work.
//
// Off-diagonal OMEGA/SIGMA entries (BLOCK matrix elements like
// `OMEGA(2,1)`) come exclusively from the fit overlay's `.ext` —
// vscode-nmtran's parsed-model API doesn't expose them today, so
// `init` is null on those rows and `fixed` defaults to false (the
// flag inheritance from `$OMEGA BLOCK ... FIX` isn't recoverable
// without parsing the .mod ourselves).

import * as path from 'node:path';
import type { NmtranParsedModel } from '../nmtran-client';
import type { ExtEstimates } from '../runtime/parse-ext-fit';
import type { LstSummary } from '../runtime/parse-lst';
import type { RunrecordTags } from '../runtime/parse-runrecord';
import type { SumoSummary } from '../runtime/parse-sumo';

/**
 * Single-row shape shared by THETA, OMEGA-diag, and SIGMA-diag
 * sections. Unified so all three render the same `LB | IE | UB | FE
 * | SE | Fixed` columns. OMEGA/SIGMA bounds (`(0, 0.1, 1)` syntax)
 * aren't exposed by vscode-nmtran today; we pass null and the
 * column renders `—`. When vscode-nmtran gains the field, no
 * inspector-side change needed — wire-through happens automatically.
 */
export interface InspectorRow {
  index: number;
  /** Access-key form: `THETA(1)`, `OMEGA(1,1)`, `OMEGA(2,1)`, `SIGMA(1,1)`. Used for `.ext` lookups and shown as a tooltip. */
  name: string;
  /**
   * Pirana-style inline-comment label from `;<text>` on the decl's
   * source line (e.g. `$THETA 4.79 ;CL` → `"CL"`). Null when the .mod
   * has no comment, when vscode-nmtran < 0.4.20, or for off-diagonal
   * BLOCK matrix elements (.ext is the source for those, no .mod
   * comment available).
   */
  label: string | null;
  lower: number | null;
  /** Initial estimate from vscode-nmtran. Null for off-diagonal OMEGA/SIGMA (BLOCK matrix elements vscode-nmtran doesn't expose). */
  init: number | null;
  upper: number | null;
  final: number | null;
  /** Absolute SE from the `.ext` -1000000001 row. Kept alongside `rse` so future surfaces (CSV export, raw-data panes) can use it; the WebView displays `rse` instead. */
  se: number | null;
  /**
   * Relative SE matching sumo's display convention (default `sd_rse=1`):
   *  - THETA          → `se / |final|`
   *  - OMEGA / SIGMA  → `(se / |final|) / 2` — relative SE on the SD scale,
   *                     the pharmacometric reporting standard
   * Null when either input is missing or `final === 0`.
   */
  rse: number | null;
  fixed: boolean;
  /** Per-parameter NUMSIGDIG from the LAST iteration block of the .lst. Null when no fit / no NUMSIGDIG row. Pinpoints poorly-estimated parameters (a NUMSIGDIG noticeably lower than the global "NO. OF SIG. DIGITS IN FINAL EST." flags a problem). */
  numSigDig: number | null;
  /** 0-based line in the .mod for click-to-decl. Null when vscode-nmtran < 0.4.18, or for off-diagonal entries. */
  declLine: number | null;
  /**
   * Boundary flag: `'lower'` when `final === lower`, `'upper'` when `final === upper`, else null.
   * Always null for FIX rows (those are stuck at the bound by design, not a convergence concern)
   * and when either side of the comparison is null. Drives the orange highlight in the WebView.
   */
  boundary: 'lower' | 'upper' | null;
}

export interface InspectorPayload {
  /** Top-of-pane summary; only present in lst-mode (fit-overlay context). */
  summary: InspectorSummary | null;
  /** Run-notes block (Description / Label / Based on / extra runrecord tags) parsed from the .mod's `;;` block. Null in mod-mode and when the .mod has no runrecord tags. */
  runNotes: InspectorRunNotes | null;
  thetas: InspectorRow[];
  /** Diagonals AND off-diagonals (BLOCK matrix elements), sorted lower-triangular row-major: (1,1) (2,1) (2,2) (3,1) (3,2) (3,3) … */
  omegas: InspectorRow[];
  sigmas: InspectorRow[];
  /** Per-EST-step diagnostics block (termination, ETABAR, shrinkages, eigenvalues). Null when not in lst-mode. */
  diagnostics: InspectorDiagnostics | null;
  /** Visualisation thresholds — values exceeding these get coloured red. */
  thresholds: InspectorThresholds;
}

export interface InspectorThresholds {
  /** Shrinkage% above this is highlighted red. Pharmacometrics convention: 30%. User-configurable. */
  shrinkageWarnPct: number;
  /** RSE% above this is highlighted red. Hard-coded at 100% (SE ≥ |estimate|, parameter is unidentified). */
  rseWarnPct: number;
}

export interface InspectorRunNotes {
  /** Parent run number from `;; Based on:`; null when absent. */
  basedOn: number | null;
  /** `;; Description:` body. */
  description: string | null;
  /** `;; Label:` body. */
  label: string | null;
  /** All other `;;` tags as ordered name → body pairs. */
  extra: { name: string; body: string }[];
}

export interface InspectorDiagnostics {
  termination: 'SUCCESSFUL' | 'TERMINATED' | null;
  /** Verbatim termination phrase (`MINIMIZATION SUCCESSFUL` / `OPTIMIZATION WAS COMPLETED` / etc.); used as the rendered label. */
  terminationPhrase: string | null;
  terminationReason: string | null;
  /** Per-ETA mean of estimates from the `ETABAR:` row. Empty when not emitted. */
  etabar: number[];
  /** Per-ETA shrinkage on the SD scale (`ETASHRINKSD(%)`). */
  etaShrinkSd: number[];
  /** Per-EPS shrinkage on the SD scale (`EPSSHRINKSD(%)`). */
  epsShrinkSd: number[];
  /** Eigenvalue range from `EIGENVALUES OF COR MATRIX`; null when no $COV ran. The condition number is taken from `sumo` (in `summary.sumo.conditionNumber`), not recomputed here — sumo already does the math. */
  eigenvalues: { min: number; max: number; values: number[] } | null;
  /** PRDERR file contents (NONMEM warnings / numerical-issue notes). Null when none was emitted. */
  prderr: { content: string; source: 'plain' | 'archive' } | null;
  /** SAEM / BAYES "Mean Acceptance Rate" — last (stationary) value. Null for FOCE / FO / IMP. */
  acceptanceRate: number | null;
}

export interface InspectorSummary {
  title: string;
  ofv: number | null;
  /** Status badges + condition-number-style diagnostics from PsN's sumo. Null when sumo wasn't run / failed. */
  sumo: SumoSummary | null;
  /** `.lst`-direct fields not in sumo (method, sig-digits, …). Null when not in lst-mode. */
  lst: LstSummary | null;
}

export interface BuildContext {
  /** Absolute path to the active `.lst` (lst-mode); omit in mod-mode. */
  lstPath?: string;
  /** Fit overlay parsed from sibling `.ext`. Null/undefined → mod-mode. */
  fit?: ExtEstimates | null;
  /** sumo-parsed status block + diagnostics. Null/undefined → not yet run / failed. */
  sumo?: SumoSummary | null;
  /** `.lst`-direct fields not in sumo (method, sig-digits, termination, shrinkages, …). */
  lst?: LstSummary | null;
  /** runrecord `;;` tags from the .mod (Description, Label, Based on, …). */
  runrecord?: RunrecordTags | null;
  /** PRDERR file contents (NONMEM warnings) — extracted by `readPrderr`. Null/undefined when none. */
  prderr?: { content: string; source: 'plain' | 'archive' } | null;
  /** User-configurable shrinkage warn threshold (percent). Default 30 (pharmacometrics convention). */
  shrinkageWarnPct?: number;
}

const DEFAULT_THRESHOLDS: InspectorThresholds = {
  shrinkageWarnPct: 30,
  rseWarnPct: 100,
};

export function buildInspectorPayload(
  model: NmtranParsedModel | null,
  ctx: BuildContext = {},
): InspectorPayload | null {
  if (!model) return null;
  const fit = ctx.fit ?? null;
  const summary: InspectorSummary | null = ctx.lstPath
    ? {
        title: path.basename(ctx.lstPath),
        ofv: fit?.ofv ?? null,
        sumo: ctx.sumo ?? null,
        lst: ctx.lst ?? null,
      }
    : null;

  // NUMSIGDIG values pair with `.ext` column order (THETA1 …
  // OMEGA(i,j) … SIGMA(i,j)). When both are available, build a
  // lookup so each row can pull its own value by access key.
  const numSigDigByName = pairNumSigDig(ctx.lst, fit);

  const thetas: InspectorRow[] = model.thetas.map((t) => {
    const name = `THETA(${t.index})`;
    const final = fit?.finals.get(name) ?? null;
    const se = fit?.standardErrors.get(name) ?? null;
    return {
      index: t.index,
      name,
      label: t.comment ?? null,
      lower: t.lower ?? null,
      init: t.init,
      upper: t.upper ?? null,
      final,
      se,
      rse: computeRse(name, final, se),
      fixed: t.fix,
      numSigDig: numSigDigByName.get(name) ?? null,
      declLine: t.line ?? null,
      boundary: computeBoundary(final, t.lower ?? null, t.upper ?? null, t.fix),
    };
  });

  const omegas = mergeMatrixRows('OMEGA', model.omegas, fit, numSigDigByName);
  const sigmas = mergeMatrixRows('SIGMA', model.sigmas, fit, numSigDigByName);

  return {
    summary,
    runNotes: ctx.runrecord ? buildRunNotes(ctx.runrecord) : null,
    thetas,
    omegas,
    sigmas,
    diagnostics: ctx.lst ? buildDiagnostics(ctx.lst, ctx.prderr ?? null) : null,
    thresholds: {
      shrinkageWarnPct: ctx.shrinkageWarnPct ?? DEFAULT_THRESHOLDS.shrinkageWarnPct,
      rseWarnPct: DEFAULT_THRESHOLDS.rseWarnPct,
    },
  };
}

/**
 * Combine diagonal entries (from vscode-nmtran's parsed model) with
 * off-diagonal BLOCK matrix elements (from the `.ext` fit overlay)
 * into a single lower-triangular-sorted row list. Off-diagonal rows
 * have no init, no decl line — vscode-nmtran's API doesn't expose
 * BLOCK matrix elements today, so they only appear when the run
 * has actually been executed (.ext exists).
 */
function mergeMatrixRows(
  prefix: 'OMEGA' | 'SIGMA',
  diagonals: { index: number; value: number; fix: boolean; line?: number; comment?: string }[],
  fit: ExtEstimates | null,
  numSigDigByName: Map<string, number>,
): InspectorRow[] {
  const rows = diagonals.map((d) => buildOmegaSigmaRow(d, prefix, fit, numSigDigByName));
  if (fit) rows.push(...offDiagonalRows(prefix, fit, numSigDigByName));
  rows.sort(compareMatrixRows);
  return rows;
}

function offDiagonalRows(
  prefix: 'OMEGA' | 'SIGMA',
  fit: ExtEstimates,
  numSigDigByName: Map<string, number>,
): InspectorRow[] {
  const rows: InspectorRow[] = [];
  for (const [name] of fit.finals) {
    const idx = parseMatrixIndex(name);
    if (!idx || !name.startsWith(prefix) || idx.row === idx.col) continue;
    rows.push(
      makeOmegaSigmaRow({
        index: idx.row,
        name,
        // Off-diagonals: vscode-nmtran's parsed-model API doesn't
        // expose BLOCK matrix elements. `.ext` iteration-0 is the
        // only init source; FIX-flag inheritance from `$OMEGA BLOCK
        // ... FIX` isn't recoverable so we display "no".
        // No .mod source → no inline comment label.
        label: null,
        init: fit.inits.get(name) ?? null,
        fix: false,
        line: null,
        fit,
        numSigDigByName,
      }),
    );
  }
  return rows;
}

/**
 * Relative SE matching PsN sumo's default `sd_rse=1` rendering. Sumo
 * source: `bin/sumo` lines 800-840 (v5.3.1) — for OMEGA / SIGMA the
 * column shown is `cvse / 2` where `cvse = SE / |estimate|`. The
 * footer note in sumo's own output explains:
 *   "The relative standard errors for omega and sigma are reported on
 *    the approximate standard deviation scale (SE/variance estimate)/2."
 * Off-diagonal OMEGA(i,j) entries follow the same /2 rule (sumo
 * doesn't special-case covariances).
 */
function computeRse(name: string, final: number | null, se: number | null): number | null {
  // NONMEM emits SE=0 for parameters that COV didn't infer — typically
  // FIXED params (no inference attempted) but also some boundary or
  // unidentifiable cases. Treating that as a valid 0% RSE is wrong:
  // 0% reads as "infinitely precise" when the truth is "no inference".
  // parseExtFit already drops the entire SE row when ALL values are
  // zero ($COV step skipped/failed); this guard handles the per-param
  // case where the row is mixed.
  if (final === null || se === null || se === 0 || final === 0) return null;
  const isOmegaOrSigma = /^(OMEGA|SIGMA)\(/.test(name);
  const factor = isOmegaOrSigma ? 0.5 : 1;
  return (se / Math.abs(final)) * factor;
}

/**
 * Pair LstSummary's `numSigDigPerParam` (positional array, .ext-column
 * order) with the access keys from `fit.finals` (insertion-ordered to
 * match the .ext header). Returns an empty Map when either source is
 * absent — callers degrade gracefully (no NUMSIGDIG cells).
 */
function pairNumSigDig(
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

function buildRunNotes(rr: RunrecordTags): InspectorRunNotes | null {
  const description = rr.tags.get('Description')?.trim() || null;
  const label = rr.tags.get('Label')?.trim() || null;
  const extra: { name: string; body: string }[] = [];
  for (const [name, body] of rr.tags) {
    if (name === 'Description' || name === 'Label') continue;
    if (body.trim() === '') continue; // hide empty-body tags
    extra.push({ name, body });
  }
  // Hide the whole block when nothing useful would render.
  if (rr.basedOn === null && description === null && label === null && extra.length === 0) {
    return null;
  }
  return { basedOn: rr.basedOn, description, label, extra };
}

function buildDiagnostics(
  lst: LstSummary,
  prderr: { content: string; source: 'plain' | 'archive' } | null,
): InspectorDiagnostics | null {
  const eigs = lst.eigenvalues;
  // Display signed min/max so the user sees if any eigenvalue is
  // negative (signals a non-PD COR matrix). The condition-number
  // value comes from sumo; we don't recompute it here.
  const eigenvalues: InspectorDiagnostics['eigenvalues'] =
    eigs.length > 0 ? { min: Math.min(...eigs), max: Math.max(...eigs), values: eigs } : null;
  // Hide block when there's nothing to show.
  const empty =
    lst.termination === null &&
    lst.etabar.length === 0 &&
    lst.etaShrinkSd.length === 0 &&
    lst.epsShrinkSd.length === 0 &&
    eigenvalues === null &&
    prderr === null &&
    lst.acceptanceRate === null;
  if (empty) return null;
  return {
    termination: lst.termination,
    terminationPhrase: lst.terminationPhrase,
    terminationReason: lst.terminationReason,
    etabar: lst.etabar,
    etaShrinkSd: lst.etaShrinkSd,
    epsShrinkSd: lst.epsShrinkSd,
    eigenvalues,
    prderr,
    acceptanceRate: lst.acceptanceRate,
  };
}

function buildOmegaSigmaRow(
  d: { index: number; value: number; fix: boolean; line?: number; comment?: string },
  prefix: 'OMEGA' | 'SIGMA',
  fit: ExtEstimates | null,
  numSigDigByName: Map<string, number>,
): InspectorRow {
  return makeOmegaSigmaRow({
    index: d.index,
    name: `${prefix}(${d.index},${d.index})`,
    label: d.comment ?? null,
    init: d.value,
    fix: d.fix,
    line: d.line ?? null,
    fit,
    numSigDigByName,
  });
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
  fix: boolean;
  line: number | null;
  fit: ExtEstimates | null;
  numSigDigByName: Map<string, number>;
}): InspectorRow {
  const final = args.fit?.finals.get(args.name) ?? null;
  const se = args.fit?.standardErrors.get(args.name) ?? null;
  return {
    index: args.index,
    name: args.name,
    label: args.label,
    lower: null,
    init: args.init,
    upper: null,
    final,
    se,
    rse: computeRse(args.name, final, se),
    fixed: args.fix,
    numSigDig: args.numSigDigByName.get(args.name) ?? null,
    declLine: args.line,
    // OMEGA/SIGMA bounds aren't exposed by vscode-nmtran today; with
    // both sides null, computeBoundary always returns null. Threaded
    // through anyway so the field is uniform across all rows and so
    // future bound-aware data lands in the right place.
    boundary: computeBoundary(final, null, null, args.fix),
  };
}

/**
 * Detect at-boundary parameters for the orange highlight. The user-facing
 * hazard is "estimator stuck against the bound" — a parameter that ran into
 * its `(lb, ie, ub)` constraint rather than converging freely. FIX rows are
 * intentionally exempt: they sit at "their bound" by design (NONMEM doesn't
 * even estimate them), so flagging them as a problem is noise.
 *
 * Strict equality (`===`) suffices because NONMEM rounds boundary-active
 * estimates to the bound itself; we don't bother with an epsilon.
 */
function computeBoundary(
  final: number | null,
  lower: number | null,
  upper: number | null,
  fix: boolean,
): 'lower' | 'upper' | null {
  if (fix || final === null) return null;
  if (lower !== null && final === lower) return 'lower';
  if (upper !== null && final === upper) return 'upper';
  return null;
}
