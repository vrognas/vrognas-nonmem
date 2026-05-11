// parseExtFit — read PsN's `psn.ext` (or the copied-back `<basename>.ext`)
// for a finished run and surface the converged estimates + standard
// errors in a form the Variables pane can render.
//
// NONMEM 7 `.ext` layout:
//   TABLE NO.  1: <method>: ...
//    ITERATION    THETA1   THETA2   OMEGA(1,1)   ...   SIGMA(1,1)   OBJ
//             0   1.0E+00  1.0E+00  1.0E-01      ...   1.0E+00      1.79E+308
//             1   ...
//    -1000000000  <final estimates>                          ← we want this
//    -1000000001  <standard errors>                          ← and this
//    -1000000002  <eigenvalues of correlation matrix>        (skipped — .lst has them)
//    -1000000003  <condition number + eigen bounds>          (skipped — sumo has it)
//    -1000000004  <OMEGA/SIGMA in SD/correlation form>       ← stdcorr finals
//    -1000000005  <SE matched to -1000000004>                ← stdcorr SEs
//    -1000000006  <FIX flags: 1=fixed, 0=estimated>          ← authoritative FIX
//    -1000000007  <termination codes per $EST>               ← term-status codes
//    -1000000008  <partial derivatives>                      (skipped)
//
// Header column names are kept verbatim for OMEGA/SIGMA (`OMEGA(1,1)`,
// `OMEGA(2,1)`, …) and rewritten for THETA: NONMEM emits `THETA1`
// without parens, our access-key convention is `THETA(1)`. Map keys
// produced here therefore match the access_keys in
// `mapParsedModelToVariables`.
//
// All-zero SE row → `standardErrors` returned empty. PsN/NONMEM emits
// the row even when `$COV` was skipped or failed; rendering "SE 0" is
// misleading, so we drop it and the caller renders "—" / hides SE.

import { parseExtBlocks } from './parse-ext-tokenizer';

const FINAL_SENTINEL = -1000000000;
const SE_SENTINEL = -1000000001;
const FINAL_STDCORR_SENTINEL = -1000000004;
const SE_STDCORR_SENTINEL = -1000000005;
const FIX_FLAGS_SENTINEL = -1000000006;
const TERM_CODES_SENTINEL = -1000000007;
const INIT_ITER = 0;

export interface ExtEstimates {
  /** Objective Function Value from the OBJ column of the final-estimates row. */
  ofv: number;
  /**
   * Initial estimates from the iteration-0 row. Includes BLOCK matrix
   * elements (`OMEGA(2,1)`, `OMEGA(3,1)` …) that vscode-nmtran's
   * parsed-model API doesn't surface — that's our only source for
   * off-diagonal inits. Diagonal inits typically agree with
   * vscode-nmtran's parsed value; we keep both sources separate so
   * the .mod stays authoritative for diagonals.
   */
  inits: Map<string, number>;
  /** access_key (`THETA(1)`, `OMEGA(1,1)`, `SIGMA(1,1)`, …) → final value. */
  finals: Map<string, number>;
  /** access_key → standard error. Empty when `$COV` step didn't run or failed. */
  standardErrors: Map<string, number>;
  /**
   * Authoritative SD / correlation form from NONMEM's `-1000000004` row:
   * diagonal `OMEGA(i,i)` is the SD √variance; off-diagonal `OMEGA(i,j)`
   * is the correlation. THETA columns pass through unchanged. Empty when
   * NONMEM didn't emit the row (older versions / aborted run). Replaces
   * the inspector's derived `Math.sqrt` / `cov / √(vᵢvⱼ)` math when
   * present — NONMEM does the propagation itself.
   */
  finalsStdcorr: Map<string, number>;
  /**
   * SEs matched to `finalsStdcorr` from the `-1000000005` row. NONMEM has
   * already done the delta-method propagation here, so these are more
   * accurate than the `cvse / 2` Taylor approximation sumo uses. Empty
   * when row absent or all values zero (no $COV, same drop rule as
   * `standardErrors`).
   */
  standardErrorsStdcorr: Map<string, number>;
  /**
   * Per-parameter FIX flags from the `-1000000006` row (1 = fixed,
   * 0 = estimated). Authoritative direct-from-NONMEM source; inspector
   * falls back to vscode-nmtran's parsed-model `fix` field when this
   * row isn't present. Empty when row absent.
   */
  fixedFlags: Map<string, boolean>;
  /**
   * Termination status codes from the `-1000000007` row, one per `$EST`
   * step. NONMEM 7 codes (per Bauer's user guide):
   *   0 = successful, 1 = rounding errors, 2 = max iterations,
   *   3 = boundary, 4 = computational issue (NaN), 5 = user interrupt,
   *   higher = covariance / other failures.
   * Empty when row absent. The inspector still string-matches the .lst's
   * "MINIMIZATION SUCCESSFUL/TERMINATED" phrase for the human-readable
   * label; this array is the machine-readable supplement.
   */
  terminationCodes: number[];
}

/**
 * Parse a PsN/NONMEM `.ext` and return finals + SEs keyed by our
 * access-key convention. Returns null when the file lacks the
 * `-1000000000` row (run aborted before convergence, or .ext truncated).
 */
export function parseExtFit(extText: string): ExtEstimates | null {
  // Use the LAST TABLE block whose header is present. This matches the
  // "last $EST step wins" rule. If an earlier block emitted (e.g.)
  // `-1000000004` but the last didn't, we naturally drop it because we
  // only inspect the last block's rows.
  const blocks = parseExtBlocks(extText);
  const last = blocks.length > 0 ? blocks[blocks.length - 1] : null;
  if (!last || !last.header) return null;
  // Header in parseExtBlocks excludes the leading 'ITERATION' token,
  // but the row-tokens here also exclude the leading iter column —
  // matched indices. Build a synthetic "with iter" view that the rest
  // of this code expects (legacy code used full token arrays with
  // leading column).
  const headerWithIter = ['ITERATION', ...last.header];

  let initRow: string[] | null = null;
  let finalRow: string[] | null = null;
  let seRow: string[] | null = null;
  let stdcorrFinalRow: string[] | null = null;
  let stdcorrSeRow: string[] | null = null;
  let fixFlagsRow: string[] | null = null;
  let termCodesRow: string[] | null = null;

  for (const { iter, tokens } of last.rows) {
    const fullRow = [String(iter), ...tokens];
    if (iter === INIT_ITER && initRow === null) initRow = fullRow;
    else if (iter === FINAL_SENTINEL) finalRow = fullRow;
    else if (iter === SE_SENTINEL) seRow = fullRow;
    else if (iter === FINAL_STDCORR_SENTINEL) stdcorrFinalRow = fullRow;
    else if (iter === SE_STDCORR_SENTINEL) stdcorrSeRow = fullRow;
    else if (iter === FIX_FLAGS_SENTINEL) fixFlagsRow = fullRow;
    else if (iter === TERM_CODES_SENTINEL) termCodesRow = fullRow;
  }

  if (!finalRow) return null;

  const finals = pickRow(headerWithIter, finalRow);
  const ofv = finals.get('OBJ');
  if (ofv === undefined) return null; // truncated .ext or missing OBJ column
  finals.delete('OBJ');

  const inits = initRow ? pickRow(headerWithIter, initRow) : new Map<string, number>();
  inits.delete('OBJ');

  const standardErrors = pickSeRow(headerWithIter, seRow);
  const finalsStdcorr = stdcorrFinalRow
    ? withoutObj(pickRow(headerWithIter, stdcorrFinalRow))
    : new Map<string, number>();
  const standardErrorsStdcorr = pickSeRow(headerWithIter, stdcorrSeRow);

  const fixedFlags = new Map<string, boolean>();
  if (fixFlagsRow) {
    const flags = pickRow(headerWithIter, fixFlagsRow);
    flags.delete('OBJ');
    for (const [name, v] of flags) fixedFlags.set(name, v === 1);
  }

  // -1000000007: one numeric column per $EST step's termination code.
  // Skip the leading sentinel token (column 0) — same as other rows —
  // and tolerate non-numeric / NaN tokens (older NONMEM 7 builds emit
  // garbage in unused columns).
  let terminationCodes: number[] = [];
  if (termCodesRow) {
    terminationCodes = termCodesRow
      .slice(1)
      .map(Number)
      .filter((v) => Number.isFinite(v) && Number.isInteger(v) && v >= 0);
  }

  return {
    ofv,
    inits,
    finals,
    standardErrors,
    finalsStdcorr,
    standardErrorsStdcorr,
    fixedFlags,
    terminationCodes,
  };
}

/**
 * Drop the `OBJ` column and the all-zero "no $COV" placeholder. Shared
 * by `-1000000001` (variance-form SE) and `-1000000005` (SD/corr-form SE)
 * — same drop rule applies: NONMEM emits a zero-row when COV didn't run.
 */
function pickSeRow(header: string[] | null, seRow: string[] | null): Map<string, number> {
  if (!header || !seRow) return new Map();
  const ses = pickRow(header, seRow);
  ses.delete('OBJ');
  return [...ses.values()].some((v) => v !== 0) ? ses : new Map();
}

function withoutObj(map: Map<string, number>): Map<string, number> {
  map.delete('OBJ');
  return map;
}

/**
 * Zip header columns to row values. Off-by-one safe: if the row is
 * shorter than the header (truncated file), missing columns are skipped.
 * Header is pre-normalised by `parseExtBlocks` (THETA1 → THETA(1) etc.),
 * so this function is now a pure zip.
 */
function pickRow(header: string[], row: string[]): Map<string, number> {
  const out = new Map<string, number>();
  // Skip column 0 (`ITERATION` / iter sentinel).
  for (let i = 1; i < header.length && i < row.length; i++) {
    const value = Number(row[i]);
    if (Number.isFinite(value)) out.set(header[i], value);
  }
  return out;
}
