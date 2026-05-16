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
import type { EstTier, MethodKind } from '../runtime/xml-est-defaults';
import type { CovarianceOptions } from '../runtime/parse-xml-problem-options';
import type { CovTier } from '../runtime/xml-cov-defaults';
import type { EstimationStepResult } from '../runtime/parse-xml-results';
import type { RawEstRecord } from '../runtime/parse-lst-est-records';
import type { LstTolerances } from '../runtime/parse-lst-tolerances';
import type { LstSummary } from '../runtime/parse-lst';
import type { RunrecordTags } from '../runtime/parse-runrecord';
import type { SumoSummary } from '../runtime/parse-sumo';
import { classifyCnv, type CnvVerdict } from './cnv-verdict';
import type { CorrelationRedFlag } from './correlation-redflags';
import { buildDiagnostics } from './fit-inspector-diagnostics';
import {
  buildPriorMaps,
  buildThetaRow,
  filterByExtColumns,
  mergeMatrixRows,
  pairNumSigDig,
} from './fit-inspector-rows';

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
  /**
   * $PRIOR data shipped per-row. `priorValue` is the prior mean
   * ($THETAP / $OMEGAP / $SIGMAP) — null when no prior record applies.
   * `priorVariance` is set on THETA rows only (from $THETAPV diagonal);
   * `priorDf` is set on OMEGA / SIGMA rows only (from $OMEGAPD /
   * $SIGMAPD, expanded per-parameter from the block-level scalar).
   * The inspector renders a single "PV/PD" column that picks whichever
   * field is non-null based on row kind. Available when the source
   * vscode-nmtran is ≥ 0.4.23; older versions don't populate these.
   */
  priorValue: number | null;
  priorVariance: number | null;
  priorDf: number | null;
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
  /** Shrinkage% above this (and below `shrinkageWarnPct`) is highlighted yellow/warn. Default 20%. */
  shrinkageBorderlineWarnPct: number;
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
  /**
   * Condition number of the COR matrix above this is highlighted RED
   * (`bad` tier — strongly ill-conditioned, suspect overparameterization).
   * Pharmacometrics convention: 1000. User-configurable via
   * `nonmem.condNumberBadThreshold`.
   */
  condNumberBadThreshold: number;
  /**
   * Condition number above this (and below `condNumberBadThreshold`) is
   * highlighted ORANGE (`warn` tier — ill-conditioned; check for highly-
   * correlated parameters). Default 100. Set ≥ `condNumberBadThreshold`
   * to disable the warn tier.
   */
  condNumberWarnThreshold: number;
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
  /** Per-EPS shrinkage on the SD scale (`EPSSHRINKSD(%)`). */
  epsShrinkSd: number[];
  /** Per-EPS shrinkage on the variance scale (`EPSSHRINKVR(%)`). */
  epsShrinkVr: number[];
  /** Eigenvalue range from `EIGENVALUES OF COR MATRIX`; null when no $COV ran. */
  eigenvalues: { min: number; max: number } | null;
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
   * Per-step tier-map: key → 'explicit' | 'explicitDefault' | 'implicit'.
   * Computed via `classifyEstStep`. Encodes the v0.0.181 coloring
   * scheme: blue for user-typed, orange for AUTO/propagation-set,
   * unstyled for default. See `EstTier` in xml-est-defaults.ts for
   * full semantics.
   */
  xmlEstimationTiers: Record<string, EstTier>[];
  /**
   * Per-step method-kind label ('fo' / 'foce' / 'foce-eval' / 'laplace'
   * / 'em'). Single source of truth for option-applicability gating
   * (renderer-side) and posdef sentinel resolution (cov-side). EM-
   * method list lives in `xml-est-defaults.ts:EM_METHODS`.
   */
  xmlEstimationMethodKinds: MethodKind[];
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
   * Per-key tier classification: `'explicit'` (blue), `'explicitDefault'`
   * (italic blue), or `'implicit'` (orange). Computed via
   * `classifyCovStep` using the user's $COV tokens. Keys absent from
   * this map render as default (unstyled). Empty `{}` when no $COV
   * record present.
   */
  xmlCovarianceTiers: Record<string, CovTier>;
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
   * Verbatim user-typed `$EST` records from the `.lst` control-stream
   * echo. Index-aligned with `xmlEstimationOptions`. Surfaces info XML
   * loses: NOABORT/NOHABORT distinction, and tokens never emitted in
   * XML (PRINT, POSTHOC, AUTO, CENTERING, ETABARCHECK, NOSORT).
   */
  lstEstRecords: RawEstRecord[];
  /**
   * Verbatim user-typed `$COV` record from the `.lst` control-stream
   * echo. Null when no $COV present. Surfaces tokens NM never emits to
   * XML (CONDITIONAL/UNCONDITIONAL, PARAFILE, PARAFPRINT, SPECIAL) —
   * without it the WebView falls back to synthesised doc-defaults and
   * misreports user-typed UNCONDITIONAL as default CONDITIONAL='yes'.
   */
  lstCovRecord: RawEstRecord | null;
  /**
   * Runtime-resolved tolerance / sig-digits values from the `.lst`'s
   * trace blocks. Used by the inspector to show "wire vs runtime"
   * annotations (e.g. `atol='0'` → ANRD=12 from BASE TOLERANCE block).
   * All fields null in mod-mode or for runs that don't emit the trace.
   */
  lstTolerances: LstTolerances;
  /** Whether the model uses an ODE solver. Gates ATOL/TOL row visibility. */
  hasOde: boolean;
  /** Whether the model has a `$LEVEL` record. Gates LEVCENTER/LEVOBJTYPE/LEVWT synthesis. */
  hasLevel: boolean;
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
  /** Whether the model uses an ODE solver (gates ATOL/TOL row visibility). */
  hasOde?: boolean;
  /** Whether the model has a `$LEVEL` record (gates LEVCENTER/LEVOBJTYPE/LEVWT synthesis). */
  hasLevel?: boolean;
  /**
   * Pirana-style `; <label>` comments extracted directly from the
   * `.mod` / `.lst`-embedded control stream by `parse-param-labels.ts`.
   * Overrides vscode-nmtran's `comment` field — empirically unreliable
   * for `$OMEGA BLOCK(N)` (labels dropped entirely) and occasionally
   * off-by-one for `$THETA`. Per-kind 1-based-index → label.
   */
  parameterLabels?: {
    thetas: Map<number, string>;
    omegas: Map<number, string>;
    sigmas: Map<number, string>;
  };
  /** User-configurable shrinkage warn threshold (percent). Default 30 (pharmacometrics convention). */
  shrinkageWarnPct?: number;
  /** Shrinkage borderline (yellow/warn) threshold. Default 20. */
  shrinkageBorderlineWarnPct?: number;
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
  /** Condition-number red-bad threshold. Default 1000 (pharmacometrics convention). */
  condNumberBadThreshold?: number;
  /** Condition-number warn (orange) threshold. Default 100. */
  condNumberWarnThreshold?: number;
}

/**
 * Single source of truth for the 9 user-configurable inspector
 * thresholds. Exported so `extension.ts` can use the same numbers as
 * its `cfg.get(key, default)` fallbacks AND the payload builder can
 * use them when callers (mostly tests) don't pass thresholds at all.
 * Changing a value here updates both ends in lockstep.
 *
 * `nsigRequired` is intentionally excluded — it's .lst-derived
 * (echoed by NONMEM from `$EST NSIG=`), not config-driven.
 */
export const INSPECTOR_THRESHOLD_DEFAULTS = {
  shrinkageWarnPct: 30,
  shrinkageBorderlineWarnPct: 20,
  rseWarnPct: 100,
  rseThetaWarnPct: 30,
  rseOmegaWarnPct: 50,
  pValWarnThreshold: 0.1,
  pValBadThreshold: 0.05,
  corrRedFlagThreshold: 0.95,
  corrWarnThreshold: 0.9,
  condNumberBadThreshold: 1000,
  condNumberWarnThreshold: 100,
} as const;

const DEFAULT_THRESHOLDS: InspectorThresholds = {
  ...INSPECTOR_THRESHOLD_DEFAULTS,
  nsigRequired: null,
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

  // Label fallback: our own extraction overrides vscode-nmtran's
  // unreliable `.comment`; if our map has no entry, fall back to it.
  const pickLabel = (
    kind: 'thetas' | 'omegas' | 'sigmas',
    idx: number,
    fallback?: string,
  ): string | null => {
    return ctx.parameterLabels?.[kind].get(idx) ?? fallback ?? null;
  };
  // Prior-lookup maps: keyed by 1-based parameter index. Defined once
  // per build call so the row builders don't `find()` linearly per row.
  const priors = buildPriorMaps(model);

  const thetas: InspectorRow[] = filteredThetas.map((t) =>
    buildThetaRow(t, fit, numSigDigByName, pickLabel('thetas', t.index, t.comment), priors.theta),
  );

  // .lst-parsed initial-matrix maps (NONMEM-authoritative, includes
  // BLOCK off-diagonals). Empty maps when no .lst loaded; `pickInit`
  // and the off-diagonal builders treat absence as "fall back further".
  const initialOmega = ctx.lst?.initialOmega ?? new Map();
  const initialSigma = ctx.lst?.initialSigma ?? new Map();
  const omegaLabels = ctx.parameterLabels?.omegas ?? new Map<number, string>();
  const sigmaLabels = ctx.parameterLabels?.sigmas ?? new Map<number, string>();
  const omegas = mergeMatrixRows(
    'OMEGA',
    filteredOmegas,
    fit,
    numSigDigByName,
    initialOmega,
    omegaLabels,
    priors.omega,
  );
  const sigmas = mergeMatrixRows(
    'SIGMA',
    filteredSigmas,
    fit,
    numSigDigByName,
    initialSigma,
    sigmaLabels,
    priors.sigma,
  );

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
            baseNrd: null,
            baseAnrd: null,
            estNrd: null,
            estAnrd: null,
            covNrd: null,
            covAnrd: null,
            siglo: null,
            sigl: null,
          },
          hasOde: ctx.hasOde ?? false,
          hasLevel: ctx.hasLevel ?? false,
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
      shrinkageBorderlineWarnPct:
        ctx.shrinkageBorderlineWarnPct ?? DEFAULT_THRESHOLDS.shrinkageBorderlineWarnPct,
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
      condNumberBadThreshold:
        ctx.condNumberBadThreshold ?? DEFAULT_THRESHOLDS.condNumberBadThreshold,
      condNumberWarnThreshold:
        ctx.condNumberWarnThreshold ?? DEFAULT_THRESHOLDS.condNumberWarnThreshold,
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
