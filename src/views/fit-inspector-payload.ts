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
import type { CnvTable } from '../runtime/parse-cnv';
import type { CorTable } from '../runtime/parse-cor';
import type { ExtEstimates } from '../runtime/parse-ext-fit';
import type { ExtTrajectory } from '../runtime/parse-ext-trajectory';
import type { EstimationOptionsStep } from '../runtime/parse-xml-options';
import {
  classifyEstStep,
  findNonDefaultKeys,
  findPropagatedKeys,
  findUserDrivenKeys,
  type EstTier,
} from '../runtime/xml-est-defaults';
import type { CovarianceOptions } from '../runtime/parse-xml-problem-options';
import {
  classifyCovKeys,
  classifyCovStep,
  resolveCovAttrToRuntime,
  type CovKeyTier,
  type CovTier,
} from '../runtime/xml-cov-defaults';
import type { EstimationStepResult } from '../runtime/parse-xml-results';
import type { RawEstRecord } from '../runtime/parse-lst-est-records';
import type { LstTolerances } from '../runtime/parse-lst-tolerances';
import type { LstSummary } from '../runtime/parse-lst';
import type { RunrecordTags } from '../runtime/parse-runrecord';
import type { SumoSummary } from '../runtime/parse-sumo';
import { classifyCnv, type CnvVerdict } from './cnv-verdict';
import { findCorrelationRedFlags, type CorrelationRedFlag } from './correlation-redflags';

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
  /**
   * True when `init` was sourced from `.ext` iteration-0 because
   * vscode-nmtran returned null/NaN (typically the empty-init
   * `$THETA (-1, , 1)` form, where NONMEM computed the midpoint).
   * Drives the muted-with-tooltip render in client.js so the user
   * knows the value isn't from the .mod source.
   */
  impliedInit: boolean;
  upper: number | null;
  final: number | null;
  /**
   * Final value already on the SD/correlation scale, from NONMEM's
   * authoritative `-1000000004` row (diagonal OMEGA(i,i) → SD,
   * off-diagonal OMEGA(i,j) → correlation; THETA passes through). Null
   * when the row is absent (older NONMEM 7 builds). When present, the
   * client renders this directly under the `√Ω/ρ` toggle instead of
   * computing `Math.sqrt(v)` / `cov / √(vᵢvⱼ)` itself — eliminates an
   * entire derivation-bug class.
   */
  finalStdcorr: number | null;
  /** Absolute SE from the `.ext` -1000000001 row. Kept alongside `rse` so future surfaces (CSV export, raw-data panes) can use it; the WebView displays `rse` instead. */
  se: number | null;
  /**
   * SE matched to `finalStdcorr`, from the `-1000000005` row. NONMEM
   * runs the delta-method propagation itself, so this is more accurate
   * than the `cvse / 2` Taylor approximation we fall back to. Null when
   * the row is absent or zero (no $COV).
   */
  seStdcorr: number | null;
  /**
   * Relative SE matching sumo's display convention (default `sd_rse=1`):
   *  - THETA          → `se / |final|`
   *  - OMEGA / SIGMA  → `(se / |final|) / 2` — relative SE on the SD scale,
   *                     the pharmacometric reporting standard
   * Null when either input is missing or `final === 0`.
   */
  rse: number | null;
  /**
   * RSE on the SD/correlation scale, computed from `seStdcorr / |finalStdcorr|`.
   * Preferred display when both stdcorr fields are present (matches NONMEM's
   * own propagation rather than the cvse/2 approximation). Null when source
   * rows are absent.
   */
  rseStdcorr: number | null;
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
  /**
   * Per-iteration trajectories from sibling `.ext`, one entry per
   * `TABLE NO.` block (chained $EST). Empty when no .ext loaded.
   * Drives the inspector's convergence-plot section. Wire-format
   * uses plain Records (not Maps) because postMessage / structured
   * clone strips Map keys; the webview reads `t.values[name]`.
   */
  trajectories: TrajectoryWire[];
}

export interface TrajectoryWire {
  method: string;
  paramNames: string[];
  iterations: number[];
  values: Record<string, number[]>;
}

export interface InspectorThresholds {
  /** Shrinkage% above this is highlighted red. Pharmacometrics convention: 30%. User-configurable. */
  shrinkageWarnPct: number;
  /**
   * RSE% above this is highlighted **red** (`bad`) regardless of
   * parameter kind — typically 100% (SE ≥ |estimate|, parameter is
   * effectively unidentified). User-configurable.
   */
  rseWarnPct: number;
  /** THETA RSE% above this (and below `rseWarnPct`) is highlighted orange (warn). Default 30%. */
  rseThetaWarnPct: number;
  /** OMEGA / SIGMA RSE% above this (and below `rseWarnPct`) is highlighted orange (warn). Default 50%. */
  rseOmegaWarnPct: number;
  /** P-value below this (and ≥ `pValBadThreshold`) is highlighted orange (warn). Default 0.1. */
  pValWarnThreshold: number;
  /** P-value below this is highlighted red (`bad`) — significant departure of ETABAR from zero. Default 0.05. */
  pValBadThreshold: number;
  /**
   * NSIG threshold from `$EST NSIG=N` (the user's requested significant
   * digits target, echoed in the .lst as "NO. OF SIG. FIGURES REQUIRED:").
   * Per-parameter NUMSIGDIG cells below this are red-highlighted —
   * "this parameter didn't reach the user's bar". Null when the .lst
   * doesn't echo the value (no $EST yet, or pre-NM7).
   */
  nsigRequired: number | null;
  /**
   * Pair-correlation `|r|` threshold for the **bad** (red) tier in the
   * diagnostics block — textbook near-redundancy convention 0.95
   * (matches Pirana / sumo). User-configurable via
   * `nonmem.corrRedFlagThreshold`.
   */
  corrRedFlagThreshold: number;
  /**
   * Pair-correlation `|r|` threshold for the **warn** (yellow) tier —
   * pairs in `[corrWarnThreshold, corrRedFlagThreshold)`. Default 0.90.
   * Same colour vocabulary as the inspector's RSE / shrinkage cells.
   * Set to ≥ `corrRedFlagThreshold` to disable the warn tier (every
   * flagged pair becomes red).
   */
  corrWarnThreshold: number;
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
  termination: 'SUCCESSFUL' | 'TERMINATED' | 'NOT_TESTED' | null;
  /** Verbatim termination phrase (`MINIMIZATION SUCCESSFUL` / `OPTIMIZATION WAS COMPLETED` / etc.); used as the rendered label. */
  terminationPhrase: string | null;
  terminationReason: string | null;
  /** Per-ETA mean of estimates from the `ETABAR:` row. Empty when not emitted. */
  etabar: number[];
  /** Per-ETA standard error of the mean from the `SE:` row in the ETABAR block. */
  etabarSe: number[];
  /** Per-ETA subject count from the `N:` row in the ETABAR block. */
  etaN: number[];
  /** Per-ETA p-value from the `P VAL.:` row (ETABAR ≠ 0 test). Empty when not emitted. */
  etaPVal: number[];
  /** Per-ETA shrinkage on the SD scale (`ETASHRINKSD(%)`). */
  etaShrinkSd: number[];
  /** Per-ETA shrinkage on the variance scale (`ETASHRINKVR(%)`). */
  etaShrinkVr: number[];
  /** Per-ETA Empirical-Bayes Variance shrinkage on SD scale (`EBVSHRINKSD(%)`). */
  ebvShrinkSd: number[];
  /** Per-ETA EBV shrinkage on variance scale (`EBVSHRINKVR(%)`). */
  ebvShrinkVr: number[];
  /** Per-EPS shrinkage on the SD scale (`EPSSHRINKSD(%)`). */
  epsShrinkSd: number[];
  /** Per-EPS shrinkage on the variance scale (`EPSSHRINKVR(%)`). */
  epsShrinkVr: number[];
  /** Eigenvalue range from `EIGENVALUES OF COR MATRIX`; null when no $COV ran. */
  eigenvalues: { min: number; max: number; values: number[] } | null;
  /** Condition number of the COR matrix. `sumo.conditionNumber` (PsN-derived) preferred; falls back to `lst.conditionNumber` (NM-direct max/min eigenvalue) when sumo wasn't run. Co-located with eigenvalues + correlation red flags in the inspector. */
  conditionNumber: number | null;
  /**
   * Termination status codes from .ext `-1000000007` row, one per `$EST`
   * step. Empty when row absent. Inspector keeps using `terminationPhrase`
   * as the rendered label (human-readable); these supplement it with the
   * machine code (0 = success, 1 = rounding, etc.) — useful when the
   * phrase is ambiguous or for filtering downstream.
   */
  terminationCodes: number[];
  /**
   * Final-iteration GRADIENT row from MONITORING OF SEARCH (LAST $EST).
   * Should be near zero at a true minimum. Empty for EM methods. The
   * inspector surfaces `max |grad|` as a quick "did we actually converge"
   * indicator alongside the SUCCESSFUL/TERMINATED label.
   */
  finalGradient: number[];
  /**
   * Number of "RESET HESSIAN" occurrences across the whole run. Each
   * reset means the optimiser had to throw out its Hessian estimate.
   * Load-bearing convergence-quality signal — NOT surfaced by sumo.
   */
  hessianResets: number;
  /**
   * Magnitude of the LAST "DIAGONAL SHIFT OF X WAS IMPOSED" message,
   * or null when no shift was needed. Non-null = NONMEM had to force
   * PD by adding to the Hessian's diagonal.
   */
  diagonalShift: number | null;
  /** Total CPU seconds from `#CPUT:` (LAST $EST). Null when absent. */
  cput: number | null;
  /** Parallel node count from `#PARA:`. Null when absent / serial run. */
  paraNodes: number | null;
  /**
   * "PARAMETER ESTIMATE IS NEAR ITS BOUNDARY" was emitted by NONMEM's
   * default-boundary-test. Authoritative .lst-direct signal — sumo
   * also reports this as a status row, but the inspector's diagnostics
   * banner is more discoverable than a small status badge.
   */
  parameterNearBoundary: boolean;
  /**
   * Per-type "DEFAULT … BOUNDARY TEST OMITTED:" flags. When any is true,
   * sumo's "No parameter near boundary" status is meaningless for that
   * variable type. Inspector adds a "boundary test omitted for X" note
   * so the user knows the absence-of-warning is unreliable.
   */
  boundaryTestOmitted: { theta: boolean; omega: boolean; sigma: boolean };
  /**
   * `R MATRIX ALGORITHMICALLY SINGULAR` was emitted by the COV step
   * (correlated with `.rmt` file written instead of `.cov`/`.cor`/`.coi`).
   * The inspector renders this as an explicit banner so the user knows
   * SEs are missing for a *reason*, not silently absent.
   */
  covMatrixSingular: 'R' | 'S' | null;
  /**
   * Verbatim matrix-method tag from the COV-step section headers
   * (`STANDARD ERROR OF ESTIMATE (X)`): one of `R`, `S`, `RSR`,
   * `From Sample Variance`, etc. Identifies which matrix the SEs came
   * from, displayed next to the (RSE%) column header so the user knows
   * the derivation. Null when no $COV ran.
   */
  rseMatrix: string | null;
  /**
   * `STANDARD ERROR OF ESTIMATE` header present (with or without
   * parenthetical). Used by the client to infer default `RSR` when
   * `rseMatrix` is null but the COV step did emit SEs (FOCE classical
   * default-$COV case).
   */
  seBlockEmitted: boolean;
  /**
   * `$DESIGN` was used (NM75+ optimal design — auto-runs `$COV MATRIX=R
   * UNCONDITIONAL`). When true, render `rseMatrix` as "from $DESIGN" so
   * the user knows the SEs are Fisher-information-derived.
   */
  hasDesign: boolean;
  /** PRDERR file contents (NONMEM warnings / numerical-issue notes). Null when none was emitted. */
  prderr: { content: string; source: 'plain' | 'archive' } | null;
  /**
   * FMSG file contents (NMTRAN parse messages / errors). When `hasErrors`
   * is true the model failed to compile (e.g. `$THETA (a, , )` triggers
   * NMTRAN error 93 "WITH NO INITIAL ESTIMATE, FINITE LOWER AND UPPER
   * BOUNDS NEEDED"); inspector renders a prominent red banner. Null
   * when FMSG is empty / not located.
   */
  fmsg: { content: string; source: 'plain' | 'archive'; hasErrors: boolean } | null;
  /** SAEM / BAYES "Mean Acceptance Rate" — last (stationary) value. Null for FOCE / FO / IMP. */
  acceptanceRate: number | null;
  /**
   * Pairwise parameter correlations with `|r| ≥ corrRedFlagThreshold`,
   * sorted by `|r|` descending, upper-triangle only (each pair once).
   * Empty when no `.cor` was loaded or no pair meets the threshold —
   * the inspector hides the section in that case so a clean run stays
   * uncluttered.
   */
  correlationRedFlags: CorrelationRedFlag[];
  /**
   * Per-`$EST`-step option dictionaries from sibling `.xml`'s
   * `<nm:estimation_options ... />` elements. Empty when no `.xml`
   * was loaded. Drives the inspector's exhaustive option-dump
   * expandable section.
   */
  xmlEstimationOptions: EstimationOptionsStep[];
  /**
   * Per-step list of attribute keys whose values differ from the
   * method's empirically-probed defaults (see
   * `runtime/xml-est-defaults.ts`). Parallel-indexed with
   * `xmlEstimationOptions` -- step `i`'s non-default keys at index
   * `i`. Empty inner array when the method has no defaults table
   * (BAYES, MAP, NM 7.7+ additions). Surfaced as blue text on the
   * value cells in the option dump.
   */
  xmlEstimationNonDefaults: string[][];
  /**
   * Per-step list of attribute keys classified as "user-driven"
   * (NONMEM requires user to set, OR per-run identity like seed /
   * file / estimation_method). Disjoint from `xmlEstimationNonDefaults`.
   * Surfaced as green text — separate visual tier from non-default
   * blue, signalling "you typed this" rather than "you customised
   * away from method default."
   */
  xmlEstimationUserDriven: string[][];
  /**
   * Per-step list of attribute keys that match the PREVIOUS step's
   * value and were NOT explicitly written on THIS step's $EST line.
   * Kept for backward compat with v0.0.179 payloads. The new (v0.0.181+)
   * `xmlEstimationTiers` field is the primary source for tier-rendering.
   */
  xmlEstimationPropagated: string[][];
  /**
   * Per-step tier-map: key → 'explicit' | 'explicitDefault' | 'implicit'.
   * Computed via `classifyEstStep`. Encodes the v0.0.181 coloring
   * scheme: blue for user-typed, orange for AUTO/propagation-set,
   * unstyled for default. See `EstTier` in xml-est-defaults.ts for
   * full semantics.
   */
  xmlEstimationTiers: Record<string, EstTier>[];
  /**
   * Per-`$EST`-step result fields from `<nm:estimation>` blocks.
   * Empty when no `.xml` was loaded. Surfaces termination_status +
   * per-step timing in the inspector (the `.lst` only carries
   * last-step timing).
   */
  xmlEstimationResults: EstimationStepResult[];
  /**
   * `$COVARIANCE` option dictionary from `<nm:problem_options>`'s
   * `cov_*` attrs. Null when no `$COV` record was present (cov_* attrs
   * absent entirely from XML) or when no `.xml` was loaded.
   */
  xmlCovarianceOptions: CovarianceOptions | null;
  /**
   * Per-key tier classification: `'nonDefault'` (blue), `'propagated'`
   * (yellow — `-1` sentinel cross-referenced against the LAST $EST step
   * being non-default), or `'userDriven'` (green — value differs from
   * the not-set sentinel). Keys absent from this map render as default
   * (no highlight). Empty `{}` when no $COV record present.
   */
  xmlCovarianceTiers: Record<string, CovKeyTier>;
  /**
   * Per-key wire→runtime resolution for $COV attrs. Keys present only
   * when wire value is a sentinel (`'-1'` or `'BLANK'`) that resolves
   * to a known runtime-effective value (e.g. `cov_atol='-1'` → '12'
   * from .lst BASE TOLERANCE block; `cov_posdef='-1'` → '0' for
   * classical, '3' for EM). The renderer displays the resolved value
   * and notes the wire format in the tooltip. Empty `{}` when no
   * sentinels are present or no $COV record.
   */
  xmlCovarianceResolved: Record<string, string>;
  /**
   * Unified $COV tier-map (v0.0.185+). `key → 'explicit' |
   * 'explicitDefault' | 'implicit'`. Same scheme as `xmlEstimationTiers`
   * — blue/italic-blue/orange. Computed via `classifyCovStep` using
   * the user's $COV tokens from the .lst echo. Empty `{}` when no
   * $COV record present. Supersedes `xmlCovarianceTiers` (kept for
   * back-compat); renderer prefers this when populated.
   */
  xmlCovarianceTiersV2: Record<string, CovTier>;
  /**
   * Verbatim user-typed `$EST` records from the `.lst` control-stream
   * echo. Index-aligned with `xmlEstimationOptions`. Surfaces info XML
   * loses: NOABORT/NOHABORT distinction, and tokens never emitted in
   * XML (PRINT, POSTHOC, AUTO, CENTERING, ETABARCHECK, NOSORT).
   */
  lstEstRecords: RawEstRecord[];
  /**
   * Runtime-resolved tolerance / sig-digits values from the `.lst`'s
   * trace blocks. Used by the inspector to show "wire vs runtime"
   * annotations (e.g. `atol='0'` → ANRD=12 from BASE TOLERANCE block).
   * All fields null in mod-mode or for runs that don't emit the trace.
   */
  lstTolerances: LstTolerances;
}

export interface InspectorSummary {
  title: string;
  ofv: number | null;
  /** Status badges + condition-number-style diagnostics from PsN's sumo. Null when sumo wasn't run / failed. */
  sumo: SumoSummary | null;
  /** `.lst`-direct fields not in sumo (method, sig-digits, …). Null when not in lst-mode. */
  lst: LstSummary | null;
  /**
   * Convergence verdict derived from sibling `.cnv` (NM 7.2+, EM/MCMC
   * with `CTYPE > 0`). Null when no `.cnv` was emitted (FOCE without
   * CTYPE, .cnv parse failed, etc). Drives the inspector meta-line
   * "EM converged / NOT converged" pill.
   */
  cnvVerdict: CnvVerdict | null;
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
  /** FMSG file contents — NMTRAN parser messages / compile errors. Null when empty. */
  fmsg?: { content: string; source: 'plain' | 'archive'; hasErrors: boolean } | null;
  /** Correlation matrix of estimates parsed from sibling `.cor`. Null when no `.cor` available. */
  cor?: CorTable | null;
  /** Convergence-test table parsed from sibling `.cnv` (NM 7.2+, EM/MCMC w/ CTYPE>0). Null otherwise. */
  cnv?: CnvTable | null;
  /** Per-iteration trajectories from sibling `.ext`, one per chained $EST. */
  trajectories?: ExtTrajectory[];
  /** Per-`$EST`-step option dictionaries from sibling `.xml`. */
  xmlEstimationOptions?: EstimationOptionsStep[];
  /** Per-`$EST`-step result fields from sibling `.xml`. */
  xmlEstimationResults?: EstimationStepResult[];
  /** `$COV` option dictionary from `<nm:problem_options>`'s `cov_*` attrs. Null when no `$COV` record. */
  xmlCovarianceOptions?: CovarianceOptions | null;
  /** Verbatim user-typed `$EST` records from `.lst` echo. Carries info XML loses (NOABORT/NOHABORT, PRINT, POSTHOC, etc.). */
  lstEstRecords?: RawEstRecord[];
  /** Verbatim user-typed `$COV` record from `.lst` echo. Used to detect explicit-tier classification for $COV options. */
  lstCovRecord?: RawEstRecord | null;
  /** Runtime-resolved tolerance / sig-digits values from `.lst` trace blocks. Used for wire-vs-runtime annotations on sentinel attrs. */
  lstTolerances?: LstTolerances;
  /** User-configurable shrinkage warn threshold (percent). Default 30 (pharmacometrics convention). */
  shrinkageWarnPct?: number;
  /** RSE% red-bad threshold (uniform across THETA / OMEGA / SIGMA). Default 100. */
  rseWarnPct?: number;
  /** THETA RSE% orange-warn threshold. Default 30. */
  rseThetaWarnPct?: number;
  /** OMEGA / SIGMA RSE% orange-warn threshold. Default 50. */
  rseOmegaWarnPct?: number;
  /** ETABAR p-value orange-warn threshold. Default 0.1. */
  pValWarnThreshold?: number;
  /** ETABAR p-value red-bad threshold. Default 0.05. */
  pValBadThreshold?: number;
  /** Pairwise correlation `|r|` red-flag (bad/red) threshold. Default 0.95. */
  corrRedFlagThreshold?: number;
  /** Pairwise correlation `|r|` warn (yellow) threshold. Default 0.90. */
  corrWarnThreshold?: number;
}

const DEFAULT_THRESHOLDS: InspectorThresholds = {
  shrinkageWarnPct: 30,
  rseWarnPct: 100,
  rseThetaWarnPct: 30,
  rseOmegaWarnPct: 50,
  pValWarnThreshold: 0.1,
  pValBadThreshold: 0.05,
  nsigRequired: null,
  corrRedFlagThreshold: 0.95,
  corrWarnThreshold: 0.9,
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
        // OFV preference order: .ext OBJ column (parseExtFit's `ofv`) →
        // .lst `#OBJV:` machine-tag (more robust than sumo's parsed text
        // because there's no second parse hop). sumo not used here at all.
        ofv: fit?.ofv ?? ctx.lst?.objv ?? null,
        sumo: ctx.sumo ?? null,
        lst: ctx.lst ?? null,
        // .cnv exists only for EM/MCMC w/ CTYPE>0; classify returns null
        // for everything else, gating the meta-line pill naturally.
        cnvVerdict: classifyCnv(ctx.cnv ?? null),
      }
    : null;

  // NUMSIGDIG values pair with `.ext` column order (THETA1 …
  // OMEGA(i,j) … SIGMA(i,j)). When both are available, build a
  // lookup so each row can pull its own value by access key.
  const numSigDigByName = pairNumSigDig(ctx.lst, fit);

  // In lst-mode the `.ext` is authoritative for the parameter count —
  // it has exactly as many `THETA<i>` / `OMEGA(i,j)` / `SIGMA(i,j)`
  // columns as the model actually has. The vscode-nmtran parser has
  // been known to return phantom extra entries for some `$THETA` /
  // `$OMEGA` forms; filter them out here so the inspector matches
  // what NONMEM ran.
  const filteredThetas = filterByExtColumns(model.thetas, fit, (t) => `THETA(${t.index})`);
  const filteredOmegas = filterByExtColumns(
    model.omegas,
    fit,
    (o) => `OMEGA(${o.index},${o.index})`,
  );
  const filteredSigmas = filterByExtColumns(
    model.sigmas,
    fit,
    (s) => `SIGMA(${s.index},${s.index})`,
  );

  const thetas: InspectorRow[] = filteredThetas.map((t) => {
    const name = `THETA(${t.index})`;
    const final = fit?.finals.get(name) ?? null;
    const se = fit?.standardErrors.get(name) ?? null;
    const initPick = pickInit(t.init, name, fit);
    // stdcorr finals/SEs are only meaningful for OMEGA / SIGMA (the
    // SD/correlation-form transform). For THETA the stdcorr row is
    // identical to the variance-form row, so populating it would be
    // duplicate work and the client never reads it for THETA anyway.
    return {
      index: t.index,
      name,
      label: t.comment ?? null,
      lower: t.lower ?? null,
      init: initPick.value,
      impliedInit: initPick.implicit,
      upper: t.upper ?? null,
      final,
      finalStdcorr: null,
      se,
      seStdcorr: null,
      rse: computeRse(name, final, se),
      rseStdcorr: null,
      // .ext `-1000000006` is authoritative when present (NONMEM-direct);
      // fall back to vscode-nmtran's parsed-model `t.fix` flag otherwise.
      fixed: fit?.fixedFlags.get(name) ?? t.fix,
      numSigDig: numSigDigByName.get(name) ?? null,
      declLine: t.line ?? null,
      boundary: computeBoundary(final, t.lower ?? null, t.upper ?? null, t.fix, true),
    };
  });

  // .lst-parsed initial-matrix maps (NONMEM-authoritative, includes
  // BLOCK off-diagonals). Empty maps when no .lst loaded; `pickInit`
  // and the off-diagonal builders treat absence as "fall back further".
  const initialOmega = ctx.lst?.initialOmega ?? new Map();
  const initialSigma = ctx.lst?.initialSigma ?? new Map();
  const omegas = mergeMatrixRows('OMEGA', filteredOmegas, fit, numSigDigByName, initialOmega);
  const sigmas = mergeMatrixRows('SIGMA', filteredSigmas, fit, numSigDigByName, initialSigma);

  return {
    summary,
    runNotes: ctx.runrecord ? buildRunNotes(ctx.runrecord) : null,
    thetas,
    omegas,
    sigmas,
    diagnostics: ctx.lst
      ? buildDiagnostics({
          lst: ctx.lst,
          sumo: ctx.sumo ?? null,
          prderr: ctx.prderr ?? null,
          fmsg: ctx.fmsg ?? null,
          fit,
          cor: ctx.cor ?? null,
          corrWarnThreshold: ctx.corrWarnThreshold ?? DEFAULT_THRESHOLDS.corrWarnThreshold,
          corrRedFlagThreshold: ctx.corrRedFlagThreshold ?? DEFAULT_THRESHOLDS.corrRedFlagThreshold,
          xmlEstimationOptions: ctx.xmlEstimationOptions ?? [],
          xmlEstimationResults: ctx.xmlEstimationResults ?? [],
          xmlCovarianceOptions: ctx.xmlCovarianceOptions ?? null,
          lstEstRecords: ctx.lstEstRecords ?? [],
          lstCovRecord: ctx.lstCovRecord ?? null,
          lstTolerances: ctx.lstTolerances ?? {
            baseNrd: null, baseAnrd: null, estNrd: null, estAnrd: null,
            covNrd: null, covAnrd: null, siglo: null, sigl: null,
          },
          // NM's default `file` for this run is `<basename>.ext`. When
          // PsN's execute wraps the model the lst is at <psn-dir>/run001.lst
          // but the wrapped control stream sets FILE=psn.ext — comparing
          // against `<basename>.ext` (e.g. `run001.ext`) flags the
          // PsN-imposed value as implicit (not the user's choice).
          expectedDefaultFile: ctx.lstPath
            ? path.basename(ctx.lstPath, path.extname(ctx.lstPath)) + '.ext'
            : null,
        })
      : null,
    thresholds: {
      shrinkageWarnPct: ctx.shrinkageWarnPct ?? DEFAULT_THRESHOLDS.shrinkageWarnPct,
      rseWarnPct: ctx.rseWarnPct ?? DEFAULT_THRESHOLDS.rseWarnPct,
      rseThetaWarnPct: ctx.rseThetaWarnPct ?? DEFAULT_THRESHOLDS.rseThetaWarnPct,
      rseOmegaWarnPct: ctx.rseOmegaWarnPct ?? DEFAULT_THRESHOLDS.rseOmegaWarnPct,
      pValWarnThreshold: ctx.pValWarnThreshold ?? DEFAULT_THRESHOLDS.pValWarnThreshold,
      pValBadThreshold: ctx.pValBadThreshold ?? DEFAULT_THRESHOLDS.pValBadThreshold,
      // NSIG is .lst-derived (echoed by NONMEM from `$EST NSIG=`), not
      // user-configurable in workspace settings — it reflects what the
      // model itself asked for.
      nsigRequired: ctx.lst?.nsigRequired ?? null,
      corrRedFlagThreshold: ctx.corrRedFlagThreshold ?? DEFAULT_THRESHOLDS.corrRedFlagThreshold,
      corrWarnThreshold: ctx.corrWarnThreshold ?? DEFAULT_THRESHOLDS.corrWarnThreshold,
    },
    trajectories: (ctx.trajectories ?? []).map(toTrajectoryWire),
  };
}

/**
 * Convert `ExtTrajectory` (Map-keyed) to `TrajectoryWire` (Record-keyed).
 * Maps are silently lost across the postMessage / structured-clone
 * boundary into the WebView, so we materialise the keys here once.
 */
function toTrajectoryWire(t: ExtTrajectory): TrajectoryWire {
  const values: Record<string, number[]> = {};
  for (const [name, arr] of t.values) values[name] = arr;
  return { method: t.method, paramNames: t.paramNames, iterations: t.iterations, values };
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
function pickInit(
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
function filterByExtColumns<T>(decls: T[], fit: ExtEstimates | null, toKey: (d: T) => string): T[] {
  if (!fit) return decls;
  return decls.filter((d) => fit.finals.has(toKey(d)));
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
  lstInitial: Map<string, number>,
): InspectorRow[] {
  const rows = diagonals.map((d) =>
    buildOmegaSigmaRow(d, prefix, fit, numSigDigByName, lstInitial),
  );
  if (fit) rows.push(...offDiagonalRows(prefix, fit, numSigDigByName, lstInitial));
  rows.sort(compareMatrixRows);
  return rows;
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
    // Init source preference for off-diagonals:
    //   1. `.lst` `0INITIAL ESTIMATE OF OMEGA` echo (NONMEM-authoritative
    //      view of the user's `$OMEGA BLOCK` numbers — what we want).
    //   2. `.ext` iteration-0 (NONMEM's runtime starting matrix; for
    //      SAEM this is the *perturbed* matrix, not the user's input,
    //      so flag it as `impliedInit: true` to render muted).
    const fromLst = lstInitial.get(name);
    const hasLst = typeof fromLst === 'number' && Number.isFinite(fromLst);
    const init = hasLst ? fromLst : (fit.inits.get(name) ?? null);
    rows.push(
      makeOmegaSigmaRow({
        index: idx.row,
        name,
        // No .mod source for off-diagonals -> no inline comment label.
        label: null,
        init,
        // Implicit only when we fell through to .ext (lst echo absent).
        impliedInit: !hasLst && init !== null,
        // Off-diagonal FIX-flag inheritance from `$OMEGA BLOCK ... FIX`
        // isn't recoverable from .lst echo (the FIXED column is per-block,
        // not per-element); keep `false` until we parse it explicitly.
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

/**
 * `buildDiagnostics` arg shape — collected into one object once the
 * positional arity hit 9 (each new XML / .lst / aux-file source adds
 * a parameter). Single call site, mechanical change, prevents the
 * function from accumulating any more positional bloat.
 */
interface BuildDiagnosticsArgs {
  lst: LstSummary;
  sumo: SumoSummary | null;
  prderr: { content: string; source: 'plain' | 'archive' } | null;
  fmsg: { content: string; source: 'plain' | 'archive'; hasErrors: boolean } | null;
  fit: ExtEstimates | null;
  cor: CorTable | null;
  corrWarnThreshold: number;
  corrRedFlagThreshold: number;
  xmlEstimationOptions: EstimationOptionsStep[];
  xmlEstimationResults: EstimationStepResult[];
  xmlCovarianceOptions: CovarianceOptions | null;
  lstEstRecords: RawEstRecord[];
  lstCovRecord: RawEstRecord | null;
  lstTolerances: LstTolerances;
  /**
   * NM's default `file` value for this run, derived as `<basename>.ext`
   * from the lst path (e.g., `run001.lst` → `run001.ext`). Null when
   * mod-mode (no lst path). Used by `classifyEstStep` to detect when
   * a non-default file like `psn.ext` (PsN's wrapper convention) was
   * imposed by tooling rather than the modeller.
   */
  expectedDefaultFile: string | null;
}

function buildDiagnostics(args: BuildDiagnosticsArgs): InspectorDiagnostics | null {
  const {
    lst,
    sumo,
    prderr,
    fmsg,
    fit,
    cor,
    corrWarnThreshold,
    corrRedFlagThreshold,
    xmlEstimationOptions,
    xmlEstimationResults,
    xmlCovarianceOptions,
    lstEstRecords,
    lstCovRecord,
    lstTolerances,
    expectedDefaultFile,
  } = args;
  const conditionNumber = sumo?.conditionNumber ?? lst.conditionNumber ?? null;
  const eigs = lst.eigenvalues;
  // Display signed min/max so the user sees if any eigenvalue is
  // negative (signals a non-PD COR matrix). The condition-number
  // value comes from sumo; we don't recompute it here.
  const eigenvalues: InspectorDiagnostics['eigenvalues'] =
    eigs.length > 0 ? { min: Math.min(...eigs), max: Math.max(...eigs), values: eigs } : null;
  const terminationCodes = fit?.terminationCodes ?? [];
  const correlationRedFlags = findCorrelationRedFlags(cor, corrWarnThreshold, corrRedFlagThreshold);
  // Hide block when there's nothing to show.
  const empty =
    lst.termination === null &&
    lst.etabar.length === 0 &&
    lst.etaShrinkSd.length === 0 &&
    lst.epsShrinkSd.length === 0 &&
    eigenvalues === null &&
    prderr === null &&
    fmsg === null &&
    lst.acceptanceRate === null &&
    terminationCodes.length === 0 &&
    lst.finalGradient.length === 0 &&
    lst.hessianResets === 0 &&
    lst.diagonalShift === null &&
    lst.cput === null &&
    lst.paraNodes === null &&
    correlationRedFlags.length === 0 &&
    xmlEstimationOptions.length === 0 &&
    xmlEstimationResults.length === 0 &&
    xmlCovarianceOptions === null;
  if (empty) return null;
  // Legacy per-step lists (kept for back-compat with older payload
  // consumers / tests). The new `xmlEstimationTiers` is the primary
  // source for v0.0.181+ tier-rendering.
  const xmlEstimationNonDefaults = xmlEstimationOptions.map(findNonDefaultKeys);
  const xmlEstimationUserDriven = xmlEstimationOptions.map(findUserDrivenKeys);
  const xmlEstimationPropagated = xmlEstimationOptions.map((step, i) => {
    if (i === 0) return [];
    const tokens = lstEstRecords[i]?.tokens ?? [];
    return findPropagatedKeys(step, xmlEstimationOptions[i - 1], tokens);
  });
  // v0.0.181+ tier-map: per-step `key → tier`. Single source of truth
  // for the inspector's coloring. Implicit tier covers BOTH AUTO-set
  // and propagation cases (visually unified — both are "NM picked
  // this, not the user").
  const xmlEstimationTiers = xmlEstimationOptions.map((step, i) => {
    const tokens = lstEstRecords[i]?.tokens ?? [];
    return classifyEstStep(step, tokens, expectedDefaultFile);
  });
  // $COV: single classifier returning a tier-map (key → 'nonDefault' |
  // 'propagated' | 'userDriven'). Propagation is cross-referenced
  // against the LAST $EST step's non-default attrs — `cov_atol='-1'`
  // is meaningless when $EST is also at default ATOL (effective value
  // is the built-in default; nothing to "look elsewhere" for).
  const lastEst = xmlEstimationOptions.length > 0
    ? xmlEstimationOptions[xmlEstimationOptions.length - 1]
    : null;
  const xmlCovarianceTiers = xmlCovarianceOptions
    ? classifyCovKeys(xmlCovarianceOptions, lastEst)
    : {};
  // v0.0.185+ unified $COV tier-map using the same explicit/implicit/
  // explicitDefault scheme as $EST. Drives the inspector's $COV
  // coloring via .lst $COV tokens (user-typed vs. not).
  const covTokens = lstCovRecord?.tokens ?? [];
  const xmlCovarianceTiersV2: Record<string, CovTier> = xmlCovarianceOptions
    ? classifyCovStep(xmlCovarianceOptions, covTokens)
    : {};
  // Per-key wire→runtime resolution for $COV sentinels (atol/tol/
  // siglcov/siglocov/knuthsumoff/posdef/file/format/ranmethod when
  // value is '-1' or 'BLANK'). Method discriminator for posdef
  // (0 classical / 3 EM) derived from the last $EST step's
  // estimation_method attr — empty/cond → classical; em-method labels
  // → em. Empty result when no $COV present.
  const methodKind: 'em' | 'classical' | null = (() => {
    const m = (lastEst?.estimation_method ?? '').toLowerCase();
    if (!m) return 'classical';
    if (m === 'imp' || m === 'impmap' || m === 'saem' || m === 'its'
        || m === 'direct' || m === 'bayes' || m === 'nuts'
        || m === 'mcmc' || m === 'chain' || m === 'sir') return 'em';
    return 'classical';
  })();
  const xmlCovarianceResolved: Record<string, string> = {};
  if (xmlCovarianceOptions) {
    for (const k of Object.keys(xmlCovarianceOptions)) {
      const resolved = resolveCovAttrToRuntime(
        k,
        xmlCovarianceOptions[k],
        lastEst,
        lstTolerances,
        methodKind,
      );
      if (resolved !== null && resolved !== xmlCovarianceOptions[k]) {
        xmlCovarianceResolved[k] = resolved;
      }
    }
  }
  return {
    termination: lst.termination,
    terminationPhrase: lst.terminationPhrase,
    terminationReason: lst.terminationReason,
    etabar: lst.etabar,
    etabarSe: lst.etabarSe,
    etaN: lst.etaN,
    etaPVal: lst.etaPVal,
    etaShrinkSd: lst.etaShrinkSd,
    etaShrinkVr: lst.etaShrinkVr,
    ebvShrinkSd: lst.ebvShrinkSd,
    ebvShrinkVr: lst.ebvShrinkVr,
    epsShrinkSd: lst.epsShrinkSd,
    epsShrinkVr: lst.epsShrinkVr,
    eigenvalues,
    conditionNumber,
    terminationCodes,
    finalGradient: lst.finalGradient,
    hessianResets: lst.hessianResets,
    diagonalShift: lst.diagonalShift,
    cput: lst.cput,
    paraNodes: lst.paraNodes,
    covMatrixSingular: lst.covMatrixSingular,
    rseMatrix: lst.rseMatrix,
    seBlockEmitted: lst.seBlockEmitted,
    hasDesign: lst.hasDesign,
    parameterNearBoundary: lst.parameterNearBoundary,
    boundaryTestOmitted: lst.boundaryTestOmitted,
    prderr,
    fmsg,
    acceptanceRate: lst.acceptanceRate,
    correlationRedFlags,
    xmlEstimationOptions,
    xmlEstimationNonDefaults,
    xmlEstimationUserDriven,
    xmlEstimationPropagated,
    xmlEstimationTiers,
    xmlEstimationResults,
    xmlCovarianceOptions,
    xmlCovarianceTiers,
    xmlCovarianceTiersV2,
    xmlCovarianceResolved,
    lstEstRecords,
    lstTolerances,
  };
}

function buildOmegaSigmaRow(
  d: { index: number; value: number; fix: boolean; line?: number; comment?: string },
  prefix: 'OMEGA' | 'SIGMA',
  fit: ExtEstimates | null,
  numSigDigByName: Map<string, number>,
  lstInitial: Map<string, number>,
): InspectorRow {
  const name = `${prefix}(${d.index},${d.index})`;
  const initPick = pickInit(d.value, name, fit, lstInitial);
  return makeOmegaSigmaRow({
    index: d.index,
    name,
    label: d.comment ?? null,
    init: initPick.value,
    impliedInit: initPick.implicit,
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
  impliedInit: boolean;
  fix: boolean;
  line: number | null;
  fit: ExtEstimates | null;
  numSigDigByName: Map<string, number>;
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
    rse: computeRse(args.name, final, se),
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
  };
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
