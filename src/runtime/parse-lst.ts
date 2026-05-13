// Pure parser for fields NONMEM writes into the `.lst` that aren't
// surfaced by `sumo`. Today: estimation method (`#METH:`),
// FOCE-essential `NO. OF SIG. DIGITS IN FINAL EST.:`, termination
// state (`MINIMIZATION SUCCESSFUL` / `TERMINATED + reason`), per-ETA
// `ETABAR` and `ETASHRINKSD(%)`, per-EPS `EPSSHRINKSD(%)`, eigenvalues
// of COR matrix.
//
// NONMEM 7+ allows chained `$EST` blocks (e.g. ITS → FOCE-INTER); each
// emits its own `#METH:` and termination block. The "method" the user
// cares about is typically the LAST one (final convergence step), so
// we take the last occurrence of each marker.
//
// Multi-line value continuations are handled: NONMEM wraps long
// arrays (>~6 ETAs) onto continuation lines that start with leading
// whitespace and contain only numeric tokens. The reader walks those
// lines until it hits an empty line or the next labelled row.

const METH_RE = /^\s*#METH:\s*(.+?)\s*$/;
// `#OBJV:` is NONMEM 7's machine-readable Objective Function Value tag
// (e.g. `#OBJV:********************************************    -638.79480       *`).
// Bauer added these `#TAG:` markers specifically so external tools could
// parse the .lst without regex-fighting the human-formatted blocks. We
// take the LAST occurrence (matches the multi-`$EST` last-step rule).
const OBJV_RE = /^\s*#OBJV:.*?(-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/;
// `#CPUT:` — total CPU seconds across all $EST steps. For parallel
// runs this != wall-clock `runtime` (CPU sums across cores), so it's a
// useful supplementary diagnostic for "is parallelization actually
// helping". Last occurrence wins for multi-$EST chains.
const CPUT_RE = /^\s*#CPUT:.*?(\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/;
// `#PARA:` — parallelization tag. Format varies across NONMEM builds
// (some emit "PARAFILE … 4 nodes", others a bare integer); we just
// grab the first integer on the line as the node count.
const PARA_RE = /^\s*#PARA:.*?(\d+)/;
const SIGDIG_RE = /NO\.\s*OF\s*SIG\.\s*DIGITS\s*IN\s*FINAL\s*EST\.:\s*([\d.]+)/i;
// `$EST NSIG=N` (alias `SIGDIGITS=N`) is the user-requested significant
// digits target. NONMEM echoes it in the .lst as "NO. OF SIG. FIGURES
// REQUIRED: N". We use it as the per-parameter NUMSIGDIG threshold —
// any column with NUMSIGDIG below this fired below the user's bar and
// gets red-highlighted in the inspector. Last $EST step wins (matches
// the multi-$EST last-step rule).
const NSIG_REQ_RE = /NO\.\s*OF\s*SIG\.\s*FIGURES\s*REQUIRED:\s*(\d+)/i;
// "RESET HESSIAN" appears once per Hessian-rebuild during iteration;
// counted globally across all $EST steps. Multiple resets = optimiser
// struggled with curvature → suspect convergence quality.
const RESET_HESSIAN_RE = /RESET\s+HESSIAN/g;
// "DIAGONAL SHIFT OF [value] WAS IMPOSED" — NONMEM forced positive-
// definiteness on the Hessian by adding this magnitude to the diagonal.
// Last occurrence wins (multi-$EST). Captures the value so downstream
// can flag "shift > 1e-3" or similar.
const DIAG_SHIFT_RE = /DIAGONAL\s+SHIFT\s+OF\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+WAS\s+IMPOSED/gi;
// FOCE / FO use "MINIMIZATION SUCCESSFUL/TERMINATED"; SAEM / IMP / BAYES
// use "OPTIMIZATION WAS COMPLETED/TERMINATED". NONMEM emits these with
// a leading `0` (page-control marker) glued to the first letter (no
// space), so `\b` boundaries don't apply — match the phrase directly.
const TERM_OK_RE = /(MINIMIZATION SUCCESSFUL|OPTIMIZATION (?:WAS )?COMPLETED)/i;
const TERM_FAIL_RE = /((?:MINIMIZATION|OPTIMIZATION) TERMINATED)/i;
// ITS / IMP / SAEM / BAYES emit one of several "completed-but-not-tested"
// phrases — the run completed but NONMEM didn't claim a true minimum.
// Empirically observed:
//   - run002 (ITS),  run003 (IMP):   `OPTIMIZATION WAS NOT TESTED FOR CONVERGENCE`
//   - run004 (SAEM step):            `STOCHASTIC PORTION WAS NOT COMPLETED`
//                                    `REDUCED STOCHASTIC PORTION WAS COMPLETED`
//   - run004 (IMP EONLY=1 step):     `EXPECTATION ONLY PROCESS WAS NOT COMPLETED`
// All map to the same `NOT_TESTED` bucket — the run finished, NONMEM
// just didn't run a convergence test. Distinct from SUCCESSFUL (true
// minimum) and TERMINATED (failure).
const TERM_NOT_TESTED_RE =
  /OPTIMIZATION\s+WAS\s+NOT\s+TESTED\s+FOR\s+CONVERGENCE|STOCHASTIC\s+PORTION\s+WAS\s+(?:NOT\s+)?COMPLETED|REDUCED\s+STOCHASTIC\s+PORTION\s+WAS\s+(?:NOT\s+)?COMPLETED|EXPECTATION\s+ONLY\s+PROCESS\s+WAS\s+(?:NOT\s+)?COMPLETED/i;
// "[RS] MATRIX ALGORITHMICALLY SINGULAR" — the COV step couldn't invert
// the requested matrix to produce SEs. NONMEM dumps the offending matrix
// to a `.rmt`/`.smt` file (depending on which) and emits "COVARIANCE
// MATRIX UNOBTAINABLE". Empirically observed:
//   - run001 / run006 ($COV MATRIX=R): R singular when data is sparse
//   - run007 ($COV MATRIX=S): S singular for the same reason
// The captured letter ('R' / 'S') drives a specific banner message
// rather than a generic "no SEs" one.
const COV_SINGULAR_RE = /([RS])\s+MATRIX\s+ALGORITHMICALLY\s+SINGULAR/gi;
// COV-step section headers carry the matrix-method tag in parentheses,
// e.g. `STANDARD ERROR OF ESTIMATE (RSR)`. Empirically observed values:
//   - `R`     — Hessian-only: 2 × R⁻¹ ; from `$COV MATRIX=R` (also what
//               `$DESIGN` defaults to)
//   - `S`     — cross-product gradient only: 4 × S⁻¹ ; from `$COV MATRIX=S`
//   - `RSR`   — sandwich (R⁻¹ S R⁻¹) ; the `$COV` default. ITS reports `S`
//               not `RSR` even with default `$COV` because ITS lacks the
//               second-derivative info needed for R; same for some IMP runs.
//   - `From Sample Variance` — BAYES / NUTS posterior variance.
// We capture the LAST occurrence (multi-`$EST` chains print one block
// per step). Fall back to the EIGENVALUES tag when a "STANDARD ERROR"
// header is missing — same parenthetical, always present when COV ran.
const SE_MATRIX_TAG_RE = /STANDARD\s+ERROR\s+OF\s+ESTIMATE\s+\(([^)]+)\)/gi;
const EIG_MATRIX_TAG_RE = /EIGENVALUES\s+OF\s+COR\s+MATRIX\s+OF\s+ESTIMATE\s+\(([^)]+)\)/gi;
// Bare SE header (no parenthetical). FOCE / FOCEI with default $COV
// emit this — sandwich `R⁻¹SR⁻¹` is the default per the $COV docs
// ("the covariance matrix will be different from the default (R⁻¹SR⁻¹)"),
// and NONMEM only attaches the matrix tag when it deviates. So a
// bare header signals "SE block was emitted, default sandwich was
// used". The display layer infers `RSR` from this when `rseMatrix`
// is null and `hasDesign` is false.
const SE_HEADER_ANY_RE = /STANDARD\s+ERROR\s+OF\s+ESTIMATE/i;
// "PARAMETER ESTIMATE IS NEAR ITS BOUNDARY" — NONMEM's default
// boundary test (controlled by THETABOUNDTEST / OMEGABOUNDTEST /
// SIGMABOUNDTEST options on $EST, all default ON) fired. Doesn't
// say which parameter inline; the user has to compare FE against
// bounds in the FINAL PARAMETER ESTIMATE block. Sumo aggregates
// this into a "Parameter near boundary" status — we re-parse it
// here so a banner can appear in the inspector's diagnostics block
// without having to dig through sumo's compound status row.
const NEAR_BOUNDARY_RE = /PARAMETER\s+ESTIMATE\s+IS\s+NEAR\s+ITS\s+BOUNDARY/i;
// "DEFAULT THETA/OMEGA/SIGMA BOUNDARY TEST OMITTED: YES/NO" — echoed
// by NONMEM when $EST has NOTHETABOUNDTEST / NOOMEGABOUNDTEST /
// NOSIGMABOUNDTEST options. When YES, sumo's "No parameter near
// boundary" status is uninformative because the test wasn't run.
const BOUNDARY_TEST_OMIT_RE =
  /DEFAULT\s+(THETA|OMEGA|SIGMA)\s+BOUNDARY\s+TEST\s+OMITTED:\s*(YES|NO)/gi;
// `$DESIGN` is an alternative SE source (NM75+, optimal-design FIM).
// Detected from the echoed control stream at the head of the .lst.
// Require the FULL spelling — `$DES` alone is the differential-equations
// record (used inside `$SUBROUTINES` ADVAN/TRANS for ODE models) and
// would false-positive otherwise. NMTRAN keyword abbreviation rules
// distinguish the two: `$DES` = ODE record specifically, `$DESIGN` = optimal design.
const DESIGN_RE = /^\s*\$DESIGN\b/im;
// Stop at: `NO. OF FUNCTION EVALUATIONS` (NONMEM's standard footer),
// `#` tag (e.g. `#TERE:`), or a blank line followed by another labelled
// line (`\n\s*\n` then anything). The blank-line guard catches truncated
// .lsts that lack the standard footer — the prior `\n\s*$` arm only
// matched at end-of-file (no /m flag), which lazily kept consuming
// content until the file ended.
const TERM_REASON_RE =
  /(?:MINIMIZATION|OPTIMIZATION)\s+TERMINATED\s*\n([\s\S]*?)(?:\n\s*NO\.|\n\s*#|\n\s*\n)/gi;
// SAEM / BAYES: `ITERATIVE LOOP N: Mean Acceptance Rate: 0.42`. The
// last value is the stationary acceptance rate after burn-in; that's
// what pharmacometricians sanity-check (target ~0.20-0.40).
const ACCEPT_RE = /Mean\s+Acceptance\s+Rate:\s+([\d.]+)/gi;
// FORTRAN scientific notation — both `E` and `D` exponents
// (`$EST FORMAT=s1PD15.8` user override). Plain decimals also pass.
const NUM_TOKEN_RE = /^[-+]?\d*\.?\d+(?:[eEdD][-+]?\d+)?$/;

export type TerminationState = 'SUCCESSFUL' | 'TERMINATED' | 'NOT_TESTED';

import { parseFortranNumber } from './parse-fortran-number';
import {
  parseInitialOmega,
  parseInitialSigma,
  type InitialMatrix,
} from './parse-initial-matrix';

export interface LstSummary {
  /** Verbatim method label from the LAST `#METH:` (back-compat field). */
  method: string | null;
  /** Compact display label derived from the LAST `method` (back-compat field, used for EVAL-ONLY pill detection). */
  methodShort: string | null;
  /**
   * All `#METH:` labels in chain order (e.g. `["Iterative Two Stage",
   * "Stochastic Approximation Expectation-Maximization", "Objective
   * Function Evaluation by Importance Sampling"]`). Empty when no
   * `#METH:` markers were found. Drives the multi-badge display in
   * the inspector for chained `$EST` workflows.
   */
  methods: string[];
  /** Compact display labels matching `methods`, derived via `shortMethodLabel`. */
  methodsShort: string[];
  /**
   * `OMEGA(i,j) -> initial value` map parsed from the .lst's `0INITIAL
   * ESTIMATE OF OMEGA:` echo. Lower-triangular, includes BLOCK
   * off-diagonals (which vscode-nmtran's parsed-model API doesn't
   * expose) and structural-zero off-diagonals from diagonal $OMEGA.
   * NONMEM-authoritative source for "what the user actually declared"
   * — preferred over `.ext` iteration-0 (which for SAEM is NONMEM's
   * perturbed starting matrix, not the user's input).
   */
  initialOmega: InitialMatrix;
  /** `SIGMA(i,j) -> initial value` map parsed from `0INITIAL ESTIMATE OF SIGMA:`. Same semantics as `initialOmega`. */
  initialSigma: InitialMatrix;
  /**
   * Final OFV from the `#OBJV:` machine-tag of the LAST `$EST` block.
   * NONMEM-direct source — preferred over sumo's parsed value (which
   * also reads the .lst, but adds a parse hop). Null when the tag is
   * absent (older NONMEM 7 builds emit only the human text).
   */
  objv: number | null;
  /**
   * Total CPU seconds from the `#CPUT:` machine-tag (LAST $EST). For
   * parallel runs CPU != wall-clock — diagnostic for parallelization
   * efficiency. Null when absent.
   */
  cput: number | null;
  /** Node count from `#PARA:` (parallel runs only). Null when absent or non-parallel. */
  paraNodes: number | null;
  /**
   * Final-iteration `GRADIENT:` row from MONITORING OF SEARCH (LAST
   * $EST step). Should be near zero at a true minimum — the largest
   * absolute value is the cheap "did we actually converge" check.
   * Empty when not emitted (e.g. EM methods — only classical FOCE/FO
   * print gradients).
   */
  finalGradient: number[];
  /**
   * Count of "RESET HESSIAN" lines across the whole .lst. Each reset
   * means the optimiser had to throw away its Hessian estimate and
   * restart with a fresh approximation — a load-bearing
   * convergence-quality signal that's NOT in sumo's status block.
   */
  hessianResets: number;
  /**
   * Magnitude of the LAST "DIAGONAL SHIFT OF X WAS IMPOSED" message,
   * or null when no shift was needed. NONMEM forces PD by adding this
   * to the diagonal — non-null = the Hessian wasn't naturally PD.
   */
  diagonalShift: number | null;
  /** `NO. OF SIG. DIGITS IN FINAL EST.:` value; null when UNREPORTABLE / absent. */
  sigDigits: number | null;
  /**
   * User-requested significant-digit target from `$EST NSIG=N` (alias
   * `SIGDIGITS=N`), echoed in the .lst as "NO. OF SIG. FIGURES REQUIRED:".
   * Default 3 in NONMEM but we surface only the explicit value when
   * present. Used as the per-parameter NUMSIGDIG threshold — any
   * parameter whose NUMSIGDIG row entry is below this didn't reach
   * the user's bar and gets red-highlighted.
   */
  nsigRequired: number | null;
  /** Last `$EST` step's termination state, or null when absent. */
  termination: TerminationState | null;
  /** Verbatim termination phrase (`MINIMIZATION SUCCESSFUL` / `OPTIMIZATION WAS COMPLETED` / `MINIMIZATION TERMINATED`); display-only — `termination` carries the OK/FAIL bit. */
  terminationPhrase: string | null;
  /** Multi-line reason text following `MINIMIZATION TERMINATED` (e.g. "DUE TO ROUNDING ERRORS (ERROR=134)"); null when SUCCESSFUL or absent. */
  terminationReason: string | null;
  /** Per-ETA mean of estimates (`ETABAR:` row). */
  etabar: number[];
  /**
   * Per-ETA standard error of the mean from the `SE:` row directly
   * below ETABAR — between-subject SE of the eta means, used to
   * compute the P-value test "is ETABAR ≠ 0". Empirically only one
   * `SE:` label appears in the .lst (in the ETABAR block); the
   * `STANDARD ERROR OF ESTIMATE` matrix-blocks use different headers.
   */
  etabarSe: number[];
  /**
   * Per-ETA sample size from the `N:` row in the ETABAR block —
   * number of subjects contributing to each ETA's mean. Different
   * across ETAs when some subjects lack relevant data. Only one `N:`
   * label appears in the .lst (in the ETABAR block).
   */
  etaN: number[];
  /**
   * Per-ETA p-value from the `P VAL.:` row (NONMEM's two-sided
   * significance test for ETABAR ≠ 0). A small p-value flags an
   * ETA whose mean differs from zero — typically a structural model
   * mis-specification or omitted covariate. Empty when not emitted
   * (some methods skip it).
   */
  etaPVal: number[];
  /** Per-ETA shrinkage on the SD scale (`ETASHRINKSD(%)`). */
  etaShrinkSd: number[];
  /** Per-ETA shrinkage on the variance scale (`ETASHRINKVR(%)`). */
  etaShrinkVr: number[];
  /**
   * Per-ETA Empirical-Bayes Variance shrinkage on the SD scale
   * (`EBVSHRINKSD(%)`). DISTINCT from `etaShrinkSd`: ETA shrinkage is
   * the shrinkage of the eta values themselves toward zero; EBV
   * shrinkage is the shrinkage of the variance of the empirical-Bayes
   * estimates relative to the population variance. Both are
   * pharmacometrically meaningful and the .lst emits both rows.
   * Empirically present in every estimation method probed (FOCEI / ITS
   * / IMP / SAEM / BAYES). Empty when not emitted.
   */
  ebvShrinkSd: number[];
  /** Per-ETA EBV shrinkage on the variance scale (`EBVSHRINKVR(%)`). */
  ebvShrinkVr: number[];
  /** Per-EPS shrinkage on the SD scale (`EPSSHRINKSD(%)`). */
  epsShrinkSd: number[];
  /** Per-EPS shrinkage on the variance scale (`EPSSHRINKVR(%)`). */
  epsShrinkVr: number[];
  /** Eigenvalues from `EIGENVALUES OF COR MATRIX OF ESTIMATE`; empty when no $COV ran. */
  eigenvalues: number[];
  /**
   * NONMEM-direct condition number of the correlation matrix of estimate
   * (max / min eigenvalue, all-positive case). Pharmacometric thresholds:
   * >100 ill-conditioning, >1000 strongly suggests overparameterization.
   * Null when:
   *   - no eigenvalues block ($COV didn't run or wasn't requested), or
   *   - any eigenvalue ≤ 0 (COR matrix not positive-definite — non-PD
   *     case where the ratio isn't a meaningful conditioning measure).
   * The inspector prefers `sumo.conditionNumber` (battle-tested PsN
   * derivation) and falls back to this when sumo wasn't run or failed.
   */
  conditionNumber: number | null;
  /** SAEM / BAYES "Mean Acceptance Rate" — last (stationary) value across iterative loops. Null when the method doesn't emit one (FOCE / FO / IMP). */
  acceptanceRate: number | null;
  /**
   * Which COV-step matrix went algorithmically singular, if any: `'R'`
   * (Hessian — `$COV MATRIX=R` or default sandwich), `'S'` (cross-product
   * gradient — `$COV MATRIX=S`), or null when COV succeeded / didn't
   * run. NONMEM emits a `.rmt` (for R) or `.smt` (for S) file alongside
   * the `COVARIANCE MATRIX UNOBTAINABLE` message. Inspector uses this
   * to render a specific banner ("R matrix singular" vs "S matrix
   * singular") rather than silently dashing the SE column.
   */
  covMatrixSingular: 'R' | 'S' | null;
  /**
   * Verbatim matrix-method tag from `STANDARD ERROR OF ESTIMATE (X)` /
   * `EIGENVALUES OF COR MATRIX OF ESTIMATE (X)` — telling the user what
   * method NONMEM actually used to derive the SEs that flow into RSE.
   * Empirically observed values: `R`, `S`, `RSR`, `From Sample Variance`.
   * Null when no $COV ran (no SEs to attribute). The inspector renders
   * this next to the (RSE%) column header so RSE numbers are
   * unambiguously labelled by their derivation.
   */
  rseMatrix: string | null;
  /**
   * `STANDARD ERROR OF ESTIMATE` header was emitted (with or without a
   * parenthetical matrix tag). Authoritative signal that the COV step
   * produced SEs. Used by the display layer to infer the default
   * sandwich `R⁻¹SR⁻¹` matrix when no parenthetical is present and
   * `$DESIGN` is not in play (e.g. FOCE / FOCEI with default `$COV` —
   * NONMEM doesn't tag the default, only deviations).
   */
  seBlockEmitted: boolean;
  /**
   * `$DESIGN` record present in the control stream (NM75+ optimal
   * design). When true, the COV step is auto-configured with
   * `MATRIX=R UNCONDITIONAL` and the SEs reflect Fisher Information,
   * not the classical sandwich. Display side wraps `rseMatrix` with
   * "from $DESIGN" when this is true so the user knows the SEs are
   * design-evaluation-derived rather than classical-COV-derived.
   */
  hasDesign: boolean;
  /**
   * "PARAMETER ESTIMATE IS NEAR ITS BOUNDARY" was emitted — NONMEM's
   * default-boundary-test fired (sumo also reports this as a status
   * row, this is the authoritative .lst-direct signal). Inspector
   * surfaces as an explicit diagnostics banner, complementing the
   * per-row strict-equality boundary highlight.
   */
  parameterNearBoundary: boolean;
  /**
   * Per-type "DEFAULT … BOUNDARY TEST OMITTED:" flags from $EST options
   * (NOTHETABOUNDTEST / NOOMEGABOUNDTEST / NOSIGMABOUNDTEST). When any
   * is true, sumo's "No parameter near boundary" status is meaningless
   * for that variable type — the inspector should warn the user.
   */
  boundaryTestOmitted: { theta: boolean; omega: boolean; sigma: boolean };
  /**
   * Per-parameter `NUMSIGDIG:` values from the LAST iteration block.
   * Same column order as the `.ext` header (THETA1 … OMEGA(i,j) …
   * SIGMA(i,j)). Empty when the .lst doesn't emit one. The caller
   * pairs these with `.ext` column names to produce per-row sig-digits.
   */
  numSigDigPerParam: number[];
}

/**
 * Parse the `.lst` text and return the LAST-$EST view of the parsed
 * fields. All-empty / null result when the file contains no recognised
 * markers (read failed / pre-NM7 format / aborted-before-estimation).
 */
export function parseLst(lstText: string): LstSummary {
  const lines = lstText.split(/\r?\n/);
  const methods: string[] = [];
  let method: string | null = null;
  let objv: number | null = null;
  let cput: number | null = null;
  let paraNodes: number | null = null;
  let sigDigits: number | null = null;
  let nsigRequired: number | null = null;
  let termination: TerminationState | null = null;
  let terminationPhrase: string | null = null;

  for (const line of lines) {
    const m = line.match(METH_RE);
    if (m) {
      const label = m[1].trim();
      methods.push(label);
      method = label; // last-wins for the back-compat scalar field
      continue;
    }
    const o = line.match(OBJV_RE);
    if (o) {
      const v = Number(o[1]);
      if (Number.isFinite(v)) objv = v;
      continue;
    }
    const c = line.match(CPUT_RE);
    if (c) {
      const v = Number(c[1]);
      if (Number.isFinite(v)) cput = v;
      continue;
    }
    const p = line.match(PARA_RE);
    if (p) {
      const v = Number(p[1]);
      if (Number.isFinite(v)) paraNodes = v;
      continue;
    }
    const s = line.match(SIGDIG_RE);
    if (s) {
      const v = Number(s[1]);
      sigDigits = Number.isFinite(v) ? v : null;
    }
    const nreq = line.match(NSIG_REQ_RE);
    if (nreq) {
      const v = Number(nreq[1]);
      if (Number.isFinite(v) && Number.isInteger(v)) nsigRequired = v;
    }
    const ok = line.match(TERM_OK_RE);
    if (ok) {
      termination = 'SUCCESSFUL';
      terminationPhrase = ok[1].toUpperCase();
      continue;
    }
    const notTested = line.match(TERM_NOT_TESTED_RE);
    if (notTested) {
      // Only set when a stronger signal hasn't already won. ITS / IMP /
      // SAEM emit one of these; if a later $EST step gets MINIMIZATION
      // SUCCESSFUL, we let that overwrite (NOT_TESTED is the weakest
      // of the three). The verbatim phrase is captured so the inspector
      // can show e.g. "STOCHASTIC PORTION WAS NOT COMPLETED" instead of
      // a synthesised label.
      if (termination === null) {
        termination = 'NOT_TESTED';
        terminationPhrase = notTested[0].toUpperCase().replace(/\s+/g, ' ');
      }
      continue;
    }
    const fail = line.match(TERM_FAIL_RE);
    if (fail) {
      termination = 'TERMINATED';
      terminationPhrase = fail[1].toUpperCase();
    }
  }

  // Termination reason: only meaningful when the FINAL `$EST` step
  // ended in TERMINATED. Multi-`$EST` chains (e.g. ITS warmup → FOCE)
  // can have a TERMINATED step earlier and a SUCCESSFUL step at the
  // end; we take the LAST occurrence of the reason text and only when
  // the final-step state was TERMINATED.
  let terminationReason: string | null = null;
  if (termination === 'TERMINATED') {
    const last = lastMatch(TERM_REASON_RE, lstText);
    if (last) {
      terminationReason =
        last[1]
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !/^NO\./i.test(l))
          .join('\n')
          .trim() || null;
    }
  }

  // Acceptance rate: take the LAST `Mean Acceptance Rate:` across the
  // iterative loops (SAEM / BAYES). FOCE / IMP runs don't emit it,
  // leaving acceptanceRate null.
  let acceptanceRate: number | null = null;
  const acceptLast = lastMatch(ACCEPT_RE, lstText);
  if (acceptLast) {
    const v = Number(acceptLast[1]);
    if (Number.isFinite(v)) acceptanceRate = v;
  }

  // Hessian-quality signals: count global resets, capture last diagonal
  // shift magnitude. Both come from anywhere in the .lst, not labelled
  // by $EST step (NONMEM doesn't fence them with markers).
  const hessianResets = (lstText.match(RESET_HESSIAN_RE) ?? []).length;
  let diagonalShift: number | null = null;
  const shiftLast = lastMatch(DIAG_SHIFT_RE, lstText);
  if (shiftLast) {
    const v = Number(shiftLast[1]);
    if (Number.isFinite(v)) diagonalShift = v;
  }

  // Read eigenvalues once, derive conditionNumber from the same array
  // so we don't pay two passes over the .lst lines.
  const eigenvalues = readEigenvalues(lines);

  return {
    method,
    methodShort: shortMethodLabel(method),
    methods,
    methodsShort: methods.map((m) => shortMethodLabel(m) ?? m),
    initialOmega: parseInitialOmega(lstText),
    initialSigma: parseInitialSigma(lstText),
    objv,
    cput,
    paraNodes,
    finalGradient: readNumericRow(lines, 'GRADIENT'),
    hessianResets,
    diagonalShift,
    sigDigits,
    nsigRequired,
    termination,
    terminationPhrase,
    terminationReason,
    ...readEtabarBlock(lines),
    etaShrinkSd: readNumericRow(lines, 'ETASHRINKSD\\(%\\)'),
    etaShrinkVr: readNumericRow(lines, 'ETASHRINKVR\\(%\\)'),
    ebvShrinkSd: readNumericRow(lines, 'EBVSHRINKSD\\(%\\)'),
    ebvShrinkVr: readNumericRow(lines, 'EBVSHRINKVR\\(%\\)'),
    epsShrinkSd: readNumericRow(lines, 'EPSSHRINKSD\\(%\\)'),
    epsShrinkVr: readNumericRow(lines, 'EPSSHRINKVR\\(%\\)'),
    eigenvalues,
    conditionNumber: computeConditionNumber(eigenvalues),
    acceptanceRate,
    covMatrixSingular: (() => {
      const last = lastMatch(COV_SINGULAR_RE, lstText);
      if (!last) return null;
      // Runtime guard against future regex changes: if someone edits
      // COV_SINGULAR_RE to capture a third letter (or NONMEM adds a
      // new code in a later version) the cast wouldn't catch it. Keep
      // the type narrow and return null on anything unexpected.
      const letter = last[1].toUpperCase();
      return letter === 'R' || letter === 'S' ? letter : null;
    })(),
    rseMatrix: readMatrixTag(lstText),
    seBlockEmitted: SE_HEADER_ANY_RE.test(lstText),
    hasDesign: DESIGN_RE.test(lstText),
    parameterNearBoundary: NEAR_BOUNDARY_RE.test(lstText),
    boundaryTestOmitted: readBoundaryTestOmitted(lstText),
    numSigDigPerParam: readNumericRow(lines, 'NUMSIGDIG'),
  };
}

/**
 * Compress a verbose NONMEM method name to a compact display label.
 * Pass-through when the name doesn't match a known pattern (covers
 * future methods / wording tweaks without breaking the inspector).
 */
export function shortMethodLabel(method: string | null): string | null {
  if (method === null) return null;
  const m = method.toLowerCase();
  // `(Evaluation)` is appended by NONMEM when MAXEVAL=0 — same method,
  // just no iterations. Strip it for the short label, then add a `-eval`
  // suffix at the end so the user knows it's an evaluation pass.
  const isEval = m.includes('(evaluation)');
  const base = isEval ? m.replace(/\(evaluation\)/g, '').trim() : m;
  const suffix = isEval ? '-eval' : '';
  // Order matters: more-specific patterns first.
  if (base.includes('first order conditional') && base.includes('interaction')) return 'FOCE-INTER' + suffix;
  if (base.includes('first order conditional')) return 'FOCE' + suffix;
  if (base.includes('iterative two stage')) return 'ITS' + suffix;
  if (base.includes('stochastic approximation')) return 'SAEM' + suffix;
  // EONLY=1 — NONMEM emits "Objective Function Evaluation by Importance
  // Sampling" verbatim (vs plain "Importance Sampling" for the iterative
  // form). Idiomatic SAEM→IMP-EONLY-OFV chain (see project memory) — the
  // user wants this distinct from a regular IMP step.
  if (base.startsWith('objective function evaluation') && base.includes('importance sampling')) {
    return 'IMP EONLY' + suffix;
  }
  if (base.includes('importance sampling')) return 'IMP' + suffix;
  if (base.includes('bayesian')) return 'BAYES' + suffix;
  // `first order` (with optional whitespace) — covers MAXEVAL=0 case
  // where NONMEM emits "First Order (Evaluation)" verbatim. Use a
  // start-of-string anchor so we don't match e.g. "first order conditional"
  // (already handled above).
  if (/^first\s+order(\s|$)/.test(base)) return 'FO' + suffix;
  // Unknown method: pass-through, but still strip `(Evaluation)` and
  // append `-eval` so the EVAL ONLY badge fires for any future NONMEM
  // method we haven't taught the inspector about (e.g. NM76+ additions).
  // Strip from the ORIGINAL `method` string (mixed-case preserved) —
  // `base` was already `.toLowerCase()`'d for pattern matching, and
  // displaying e.g. `monte carlo em-eval` instead of `Monte Carlo EM-eval`
  // would be uglier than matching the non-eval pass-through's casing.
  return isEval
    ? method.replace(/\(evaluation\)/gi, '').replace(/\s+/g, ' ').trim() + '-eval'
    : method;
}

/**
 * Read a labelled row of space-separated numbers, including any
 * continuation lines NONMEM wrote when the values overflow one line
 * (typical for `ETABAR` / `ETASHRINKSD(%)` once N_ETAs > ~6). A
 * continuation line starts with leading whitespace and contains
 * only numeric tokens — no label.
 *
 * The label is interpreted as a regex fragment so callers can
 * include `(`, `)`, `%`, etc. Returns [] when no matching label is
 * present. Picks the LAST occurrence of the label, matching the
 * "last $EST step" rule used throughout this parser.
 */
function readNumericRow(lines: string[], labelPattern: string): number[] {
  const re = new RegExp(`^\\s*${labelPattern}\\s*:?\\s+(.+)$`);
  let startIdx = -1;
  let firstRowRest = '';
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) {
      startIdx = i;
      firstRowRest = m[1];
    }
  }
  if (startIdx === -1) return [];
  const values = extractNumbers(firstRowRest);
  for (let i = startIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '') break; // empty line ends the block
    const tokens = trimmed.split(/\s+/);
    if (!tokens.every((t) => NUM_TOKEN_RE.test(t))) break; // next labelled row
    values.push(...tokens.map(Number).filter(Number.isFinite));
  }
  return values;
}

/**
 * Read three "DEFAULT (THETA|OMEGA|SIGMA) BOUNDARY TEST OMITTED:" flags
 * from the .lst's $EST options echo. Defaults to all-false when the
 * lines aren't present (e.g. truncated .lst, pre-NM7).
 */
function readBoundaryTestOmitted(text: string): {
  theta: boolean;
  omega: boolean;
  sigma: boolean;
} {
  const out = { theta: false, omega: false, sigma: false };
  for (const m of text.matchAll(BOUNDARY_TEST_OMIT_RE)) {
    const which = m[1].toUpperCase() as 'THETA' | 'OMEGA' | 'SIGMA';
    const omitted = m[2].toUpperCase() === 'YES';
    if (which === 'THETA') out.theta = omitted;
    else if (which === 'OMEGA') out.omega = omitted;
    else if (which === 'SIGMA') out.sigma = omitted;
  }
  return out;
}

/**
 * Run a global-flag regex against the text and return the LAST match,
 * or null when there are zero matches. Centralised so the four sites
 * that need "last-occurrence wins" semantics (multi-`$EST` chains all
 * end up running this) share one idiom.
 */
function lastMatch(re: RegExp, text: string): RegExpMatchArray | null {
  const all = [...text.matchAll(re)];
  return all.length === 0 ? null : all[all.length - 1];
}

/**
 * Read the ETABAR / SE / N / P VAL. rows positionally — anchor on the
 * ETABAR line and read the next ~20 lines for SE / N / P VAL. labels.
 * The bare labels `SE` and `N` are too generic to grep globally —
 * NONMEM emits these strings in matrix-block column headers and other
 * tabular contexts. Anchoring eliminates the collision and makes the
 * "last $EST step's ETABAR" semantics explicit (we walk forward from
 * the LAST `ETABAR:` occurrence so multi-$EST chains naturally pick
 * the final step).
 */
function readEtabarBlock(lines: string[]): {
  etabar: number[];
  etabarSe: number[];
  etaN: number[];
  etaPVal: number[];
} {
  // Find LAST ETABAR occurrence (multi-$EST: one per step; we want the
  // final). Forward-scan capturing latest hit — same complexity as the
  // backward scan but cache-friendlier on large .lsts and matches the
  // forward-scan idiom used everywhere else in this file.
  let etabarIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*ETABAR\s*:?\s+\S/.test(lines[i])) etabarIdx = i;
  }
  if (etabarIdx === -1) {
    return { etabar: [], etabarSe: [], etaN: [], etaPVal: [] };
  }
  // Sub-window from the start through the ETABAR block — enough for
  // the SE / N / P VAL rows plus continuation lines, but stopping
  // before the next .lst section. The 30-line cap is a fallback;
  // section-boundary detection is the primary stop so a chained-$EST
  // run's matrix-method `SE:` header (which lives further down in
  // `STANDARD ERROR OF ESTIMATE` blocks) can't false-match for
  // `readNumericRow`'s last-match scan.
  let winEnd = Math.min(lines.length, etabarIdx + 30);
  for (let i = etabarIdx + 1; i < winEnd; i++) {
    const l = lines[i];
    if (/^\s*STANDARD\s+ERROR\s+OF\s+ESTIMATE/i.test(l)
        || /^\s*EIGENVALUES\s+OF\s+COR\s+MATRIX/i.test(l)
        || /^\s*(OMEGA|SIGMA)\s+-\s+(COV|CORR)\s+MATRIX/i.test(l)) {
      winEnd = i;
      break;
    }
  }
  const window = lines.slice(0, winEnd);
  // For each label read positionally within the window using the same
  // continuation-line rules as readNumericRow.
  return {
    etabar: readNumericRow(window, 'ETABAR'),
    etabarSe: readNumericRow(window.slice(etabarIdx + 1), 'SE'),
    etaN: readNumericRow(window.slice(etabarIdx + 1), 'N'),
    // `P VAL.` may sit either between SE/N (older NONMEM) or after them
    // (modern). Either way it's within the 30-line window.
    etaPVal: readNumericRow(window.slice(etabarIdx + 1), 'P VAL\\.'),
  };
}

/**
 * Pick the LAST `STANDARD ERROR OF ESTIMATE (X)` parenthetical, falling
 * back to the EIGENVALUES tag when no SE-block header was emitted (some
 * methods print eigenvalues without a separate SE header). Returns null
 * when neither tagged block exists (no $COV ran).
 */
function readMatrixTag(text: string): string | null {
  const se = lastMatch(SE_MATRIX_TAG_RE, text);
  if (se) return se[1].trim();
  const eig = lastMatch(EIG_MATRIX_TAG_RE, text);
  if (eig) return eig[1].trim();
  return null;
}

/**
 * Find the `EIGENVALUES OF COR MATRIX` block and extract the numeric
 * values from the rows below it. Skips the column-index row (all
 * integers) that NONMEM emits between the header and the values.
 * Stops at the first non-numeric line / blank-then-non-numeric.
 */
function readEigenvalues(lines: string[]): number[] {
  const startIdx = lines.findIndex((l) => /EIGENVALUES OF COR MATRIX/.test(l));
  if (startIdx === -1) return [];
  const values: number[] = [];
  let seenValues = false;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '') {
      if (seenValues) break; // blank line after values ends the block
      continue; // blank line before values is fine
    }
    const tokens = trimmed.split(/\s+/);
    if (!tokens.every((t) => NUM_TOKEN_RE.test(t))) break; // next section
    // Column-index row: all positive integers, no decimal/exponent.
    const allInts = tokens.every((t) => /^\d+$/.test(t));
    if (allInts && !seenValues) continue; // header column indices
    if (allInts) break; // unexpected; stop rather than mix
    values.push(...tokens.map(parseFortranNumber).filter(Number.isFinite));
    seenValues = true;
  }
  return values;
}

function extractNumbers(text: string): number[] {
  const out: number[] = [];
  for (const tok of text.trim().split(/\s+/)) {
    if (!NUM_TOKEN_RE.test(tok)) continue;
    const n = parseFortranNumber(tok);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * Condition number of the COR matrix as max/min eigenvalue ratio.
 * Returns null when:
 *   - empty input (no $COV ran), or
 *   - any eigenvalue ≤ 0 (non-PD case — ratio isn't a meaningful
 *     conditioning measure; the negative eigenvalue itself is the
 *     diagnostic signal in that case, surfaced via the eigenvalues
 *     min/max display).
 * NONMEM doesn't sort the emitted eigenvalues; we min/max here rather
 * than relying on positional order.
 */
function computeConditionNumber(eigs: number[]): number | null {
  if (eigs.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const v of eigs) {
    if (!Number.isFinite(v) || v <= 0) return null;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return max / min;
}
