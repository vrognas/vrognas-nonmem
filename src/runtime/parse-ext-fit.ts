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
  let header: string[] | null = null;
  let initRow: string[] | null = null;
  let finalRow: string[] | null = null;
  let seRow: string[] | null = null;
  let stdcorrFinalRow: string[] | null = null;
  let stdcorrSeRow: string[] | null = null;
  let fixFlagsRow: string[] | null = null;
  let termCodesRow: string[] | null = null;

  for (const rawLine of extText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const tokens = line.split(/\s+/);
    if (tokens[0] === 'TABLE') {
      // Multi-$EST: each $EST emits its own TABLE / iteration block.
      // Reset ALL captured rows on each new TABLE so the LAST table's
      // values win (matches the "last $EST step" rule we use throughout).
      // Without this, an earlier step that emitted e.g. `-1000000004`
      // (stdcorr) but a later step that didn't would leak the earlier
      // step's stdcorr forward as if it were the final-step's result.
      initRow = null;
      finalRow = null;
      seRow = null;
      stdcorrFinalRow = null;
      stdcorrSeRow = null;
      fixFlagsRow = null;
      termCodesRow = null;
      continue;
    }
    if (tokens[0] === 'ITERATION') {
      header = tokens;
      continue;
    }
    const iter = Number(tokens[0]);
    if (!Number.isFinite(iter)) continue;
    if (iter === INIT_ITER && initRow === null) initRow = tokens;
    else if (iter === FINAL_SENTINEL) finalRow = tokens;
    else if (iter === SE_SENTINEL) seRow = tokens;
    else if (iter === FINAL_STDCORR_SENTINEL) stdcorrFinalRow = tokens;
    else if (iter === SE_STDCORR_SENTINEL) stdcorrSeRow = tokens;
    else if (iter === FIX_FLAGS_SENTINEL) fixFlagsRow = tokens;
    else if (iter === TERM_CODES_SENTINEL) termCodesRow = tokens;
  }

  if (!header || !finalRow) return null;

  const finals = pickRow(header, finalRow);
  const ofv = finals.get('OBJ');
  if (ofv === undefined) return null; // truncated .ext or missing OBJ column
  finals.delete('OBJ');

  const inits = initRow ? pickRow(header, initRow) : new Map<string, number>();
  inits.delete('OBJ');

  const standardErrors = pickSeRow(header, seRow);
  const finalsStdcorr = stdcorrFinalRow
    ? withoutObj(pickRow(header, stdcorrFinalRow))
    : new Map<string, number>();
  const standardErrorsStdcorr = pickSeRow(header, stdcorrSeRow);

  const fixedFlags = new Map<string, boolean>();
  if (fixFlagsRow) {
    const flags = pickRow(header, fixFlagsRow);
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
 * Zip header columns to row values, applying our access-key rewrite for
 * THETA columns (`THETA1` → `THETA(1)`). Off-by-one safe: if the row is
 * shorter than the header (truncated file), missing columns are skipped.
 */
function pickRow(header: string[], row: string[]): Map<string, number> {
  const out = new Map<string, number>();
  // Skip column 0 (`ITERATION` / iter sentinel).
  for (let i = 1; i < header.length && i < row.length; i++) {
    const key = rewriteHeader(header[i]);
    const value = Number(row[i]);
    if (Number.isFinite(value)) out.set(key, value);
  }
  return out;
}

function rewriteHeader(col: string): string {
  // `THETA1` → `THETA(1)`. OMEGA(1,1) and SIGMA(1,1) pass through.
  // OBJ passes through unchanged so the caller can extract it.
  const m = col.match(/^THETA(\d+)$/);
  return m ? `THETA(${m[1]})` : col;
}
