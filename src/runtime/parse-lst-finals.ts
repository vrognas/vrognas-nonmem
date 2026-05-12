// Parse the `FINAL PARAMETER ESTIMATE` and `STANDARD ERROR OF ESTIMATE`
// tabular blocks from a NONMEM `.lst`. Used as a fallback overlay when
// no sibling `.ext` exists (run outputs were moved / renamed and the
// .lst is the only file we have) — without these, the Fit Inspector's
// THETA / OMEGA / SIGMA tables show LB/IE/UB columns only and the FE/
// SE/RSE columns are blank.
//
// Block layout (NONMEM 7.6, verified empirically):
//
//   ********************  FINAL PARAMETER ESTIMATE  ********************
//   ...banner...
//
//    THETA - VECTOR OF FIXED EFFECTS PARAMETERS   *********
//
//            TH 1      TH 2      ...      TH N
//
//            8.87E-01 -2.13E+00 ...       7.17E-02
//
//    OMEGA - COV MATRIX FOR RANDOM EFFECTS - ETAS  ********
//            ETA1     ETA2 ...
//    ETA1
//   +        0.10E+00
//    ETA2
//   +        0.05E+00  0.10E+00
//    ...
//
//    OMEGA - CORR MATRIX FOR RANDOM EFFECTS - ETAS  *******
//    ...skip — we want COV form, not CORR...
//
//    SIGMA - COV MATRIX FOR RANDOM EFFECTS - EPSILONS  ****
//            EPS1
//    EPS1
//   +        1.00E+00
//
// Standard errors follow the identical layout after the
// `STANDARD ERROR OF ESTIMATE` banner. Non-estimated SEs render as
// `.........` (a row of dots) — NM's "not computed" marker. We parse
// those as null/NaN and drop them at synthesis time.
//
// Wide tables wrap horizontally: when there are more than ~7 columns
// the values continue on a continuation line that has only numerics
// (no leading label). Same for OMEGA/SIGMA BLOCK rows. We handle this
// by treating consecutive numeric-only lines as a continuation of the
// previous row.

const FINAL_BANNER_RE = /FINAL PARAMETER ESTIMATE/;
const SE_BANNER_RE = /STANDARD ERROR OF ESTIMATE/;
const NEXT_SECTION_RE = /^\s*\*+\s*$/; // banner separator (asterisks line)
const THETA_HEADER_RE = /^\s*THETA - VECTOR OF FIXED EFFECTS/;
const OMEGA_COV_HEADER_RE = /^\s*OMEGA - COV MATRIX FOR RANDOM EFFECTS/;
const SIGMA_COV_HEADER_RE = /^\s*SIGMA - COV MATRIX FOR RANDOM EFFECTS/;
// OMEGA/SIGMA CORR forms are alternate views we deliberately skip —
// `OMEGA - CORR MATRIX ... - ETAS` etc. The COV form is the one we
// surface as `finalOmegas` (variance + covariance).
const CORR_HEADER_RE = /CORR MATRIX FOR RANDOM EFFECTS/;
// `+        0.10E+00` — leading `+` then values.
const PLUS_VALUES_RE = /^\s*\+\s*(.*)$/;
// `ETA1` / `EPS1` etc — row label preceding the `+` line.
const ROW_LABEL_RE = /^\s*(ETA|EPS)(\d+)\s*$/;
// `         8.87E-01 -2.13E+00 ...` — bare numeric line (THETA values).
const NUMERIC_LINE_RE = /^\s*[-+\d.]/;

export interface LstFinalEstimates {
  /** 1-based THETA(i) → final value. Empty when block absent. */
  thetas: Map<string, number>;
  /** OMEGA(i,j) lower-triangular → final covariance. Diagonals are variances. */
  omegas: Map<string, number>;
  /** SIGMA(i,j) lower-triangular → final value. */
  sigmas: Map<string, number>;
}

/**
 * Synthesise an `ExtEstimates`-shape object from the parsed `.lst`
 * blocks — used by the Fit Inspector as a fallback overlay when no
 * sibling `.ext` exists. Caller passes the OFV from the `#OBJV:`
 * machine-tag (already on `LstSummary`) so we don't re-parse it.
 *
 * Fields we DON'T populate (no source in the .lst tabular blocks):
 *   - `inits` — model decls (vscode-nmtran) and lst.initialOmega
 *     already provide these.
 *   - `finalsStdcorr` / `standardErrorsStdcorr` — only present in
 *     `.ext` row `-1000000004` / `-1000000005`. The inspector falls
 *     back to its own √variance / cov√(varᵢ·varⱼ) math.
 *   - `fixedFlags` — vscode-nmtran's `fix` attribute on each decl is
 *     the fallback the inspector already uses when `.ext` lacks the
 *     `-1000000006` row.
 *   - `terminationCodes` — `.ext` row `-1000000007`. We use the .lst's
 *     `MINIMIZATION SUCCESSFUL/TERMINATED` phrase for the human verdict.
 *
 * Returns null when no `FINAL PARAMETER ESTIMATE` block was found AND
 * no OFV was supplied — caller treats as "no fit available" (the
 * init-only path).
 */
import type { ExtEstimates } from './parse-ext-fit';

export function synthesizeFitFromLst(
  lstText: string,
  ofv: number | null,
): ExtEstimates | null {
  const finals = parseLstFinals(lstText);
  if (!finals || ofv === null) return null;
  // Drop fixed-zero SE entries (NM emits `0.00E+00` for fixed params;
  // the `.ext` parser drops the all-zero SE row entirely with the same
  // rationale — display would mislead). Mirror that here.
  const ses = parseLstFinalsSe(lstText);
  const allKeys = new Map<string, number>([
    ...finals.thetas,
    ...finals.omegas,
    ...finals.sigmas,
  ]);
  const seMerged = new Map<string, number>();
  if (ses) {
    for (const [k, v] of [...ses.thetas, ...ses.omegas, ...ses.sigmas]) {
      if (Number.isFinite(v) && v !== 0) seMerged.set(k, v);
    }
  }
  return {
    ofv,
    inits: new Map(),
    finals: allKeys,
    standardErrors: seMerged,
    finalsStdcorr: new Map(),
    standardErrorsStdcorr: new Map(),
    fixedFlags: new Map(),
    terminationCodes: [],
  };
}

/**
 * Parse the `FINAL PARAMETER ESTIMATE` block. Returns null when the
 * banner isn't present in `lstText` (run aborted, file truncated).
 * Empty maps for kinds whose section is absent (e.g. no `$SIGMA`).
 */
export function parseLstFinals(lstText: string): LstFinalEstimates | null {
  return parseEstimateBlock(lstText, FINAL_BANNER_RE);
}

/**
 * Parse the `STANDARD ERROR OF ESTIMATE` block. Non-estimated values
 * (rendered as `.........` by NM) are dropped — caller treats absence
 * as "SE not computed" same as the `.ext` all-zero SE-row drop rule.
 * Returns null when the banner isn't present (no $COV / cov failed).
 */
export function parseLstFinalsSe(lstText: string): LstFinalEstimates | null {
  return parseEstimateBlock(lstText, SE_BANNER_RE);
}

function parseEstimateBlock(lstText: string, bannerRe: RegExp): LstFinalEstimates | null {
  const lines = lstText.split(/\r?\n/);
  const start = lines.findIndex((l) => bannerRe.test(l));
  if (start === -1) return null;

  const out: LstFinalEstimates = {
    thetas: new Map(),
    omegas: new Map(),
    sigmas: new Map(),
  };

  // Walk forward from the banner until we hit the next banner (asterisks
  // line followed by another `********  …  ********` block) OR EOF.
  let i = start + 1;
  while (i < lines.length) {
    const line = lines[i];
    // Bail on next big banner (next $EST step's FINAL, or the next
    // major section like `1NONLINEAR MIXED EFFECTS MODEL PROGRAM`).
    if (i > start + 1 && /^\s*\*{40,}/.test(line) && /\*{40,}\s*$/.test(line)) {
      // Look ahead — if the next 2 lines contain a recognised banner
      // word, the block has ended.
      const ahead = lines.slice(i, Math.min(i + 4, lines.length)).join('\n');
      if (/COVARIANCE MATRIX|EIGENVALUES|FINAL PARAMETER|STANDARD ERROR|CORRELATION MATRIX OF ESTIMATE/.test(ahead)) {
        break;
      }
    }
    if (THETA_HEADER_RE.test(line)) {
      const next = consumeThetaSection(lines, i + 1);
      assignThetas(next.values, out.thetas);
      i = next.cursor;
      continue;
    }
    if (OMEGA_COV_HEADER_RE.test(line)) {
      const next = consumeMatrixSection(lines, i + 1);
      assignMatrix('OMEGA', next.rows, out.omegas);
      i = next.cursor;
      continue;
    }
    if (SIGMA_COV_HEADER_RE.test(line)) {
      const next = consumeMatrixSection(lines, i + 1);
      assignMatrix('SIGMA', next.rows, out.sigmas);
      i = next.cursor;
      continue;
    }
    if (CORR_HEADER_RE.test(line)) {
      // Skip CORR section entirely — advance past its values lines until
      // the next section header or banner.
      i = skipUntilNextHeader(lines, i + 1);
      continue;
    }
    i++;
  }
  return out;
}

/**
 * Consume a THETA value section. Expects:
 *   - Header row `TH 1  TH 2 ...` (we skip)
 *   - Blank
 *   - One or more numeric value lines (continues across line wrap when
 *     many params)
 *   - Blank → end
 *
 * Returns the collected values + the cursor position past the section.
 */
function consumeThetaSection(
  lines: string[],
  start: number,
): { values: number[]; cursor: number } {
  const values: number[] = [];
  let sawHeader = false;
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    // Section boundary — next OMEGA / SIGMA / CORR / banner.
    if (
      OMEGA_COV_HEADER_RE.test(line) ||
      SIGMA_COV_HEADER_RE.test(line) ||
      CORR_HEADER_RE.test(line) ||
      /^\s*\*{40,}/.test(line)
    ) {
      return { values, cursor: i };
    }
    // `TH 1  TH 2 ...` header line.
    if (/^\s*TH\s+\d+/.test(line)) {
      sawHeader = true;
      i++;
      continue;
    }
    if (sawHeader && NUMERIC_LINE_RE.test(line)) {
      values.push(...parseNumberLine(line));
      i++;
      continue;
    }
    i++;
  }
  return { values, cursor: i };
}

interface MatrixRow {
  /** 1-based row index (from `ETA<n>` / `EPS<n>` label). */
  rowIdx: number;
  /** Column values, 1-indexed by array position. Length === rowIdx for BLOCK; 1 for diagonal. */
  values: number[];
}

/**
 * Consume one OMEGA / SIGMA COV MATRIX section. Returns the row-by-row
 * lower-triangular values + cursor past the section.
 */
function consumeMatrixSection(
  lines: string[],
  start: number,
): { rows: MatrixRow[]; cursor: number } {
  const rows: MatrixRow[] = [];
  let currentRow: MatrixRow | null = null;
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (
      OMEGA_COV_HEADER_RE.test(line) ||
      SIGMA_COV_HEADER_RE.test(line) ||
      CORR_HEADER_RE.test(line) ||
      /^\s*\*{40,}/.test(line) ||
      NEXT_SECTION_RE.test(line.trim())
    ) {
      if (currentRow) rows.push(currentRow);
      return { rows, cursor: i };
    }
    const labelMatch = line.match(ROW_LABEL_RE);
    if (labelMatch) {
      if (currentRow) rows.push(currentRow);
      currentRow = { rowIdx: parseInt(labelMatch[2], 10), values: [] };
      i++;
      continue;
    }
    const plusMatch = line.match(PLUS_VALUES_RE);
    if (plusMatch && currentRow) {
      currentRow.values.push(...parseNumberLine(plusMatch[1]));
      i++;
      continue;
    }
    // Numeric-only continuation line for a wide row (BLOCK rows wider
    // than ~7 cols wrap).
    if (currentRow && NUMERIC_LINE_RE.test(line) && !line.trim().startsWith('+')) {
      currentRow.values.push(...parseNumberLine(line));
      i++;
      continue;
    }
    i++;
  }
  if (currentRow) rows.push(currentRow);
  return { rows, cursor: i };
}

/**
 * Skip lines belonging to a section we don't care about (e.g. CORR
 * MATRIX form when we want COV). Returns cursor at the next header.
 */
function skipUntilNextHeader(lines: string[], start: number): number {
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (
      THETA_HEADER_RE.test(line) ||
      OMEGA_COV_HEADER_RE.test(line) ||
      SIGMA_COV_HEADER_RE.test(line) ||
      /^\s*\*{40,}/.test(line)
    ) {
      return i;
    }
  }
  return lines.length;
}

/**
 * Tokenise a numeric-row line. `.........` (NM's not-estimated marker)
 * yields `NaN`; consumer drops those before populating maps.
 */
function parseNumberLine(line: string): number[] {
  const tokens = line.trim().split(/\s+/);
  const out: number[] = [];
  for (const t of tokens) {
    if (/^\.+$/.test(t)) {
      out.push(NaN); // "not computed" marker
      continue;
    }
    const n = Number(t);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function assignThetas(values: number[], target: Map<string, number>): void {
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i])) target.set(`THETA(${i + 1})`, values[i]);
  }
}

function assignMatrix(prefix: 'OMEGA' | 'SIGMA', rows: MatrixRow[], target: Map<string, number>): void {
  for (const row of rows) {
    for (let col = 0; col < row.values.length; col++) {
      const v = row.values[col];
      if (!Number.isFinite(v)) continue;
      // Lower-triangular: row N has N values, indexed (N, 1), (N, 2), …, (N, N).
      target.set(`${prefix}(${row.rowIdx},${col + 1})`, v);
    }
  }
}
