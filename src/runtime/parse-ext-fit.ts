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
//    -1000000002  <covariance values>                        (skipped)
//    -1000000003+ <other diagnostic rows>                    (skipped)
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

  for (const rawLine of extText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const tokens = line.split(/\s+/);
    if (tokens[0] === 'TABLE') {
      // Multi-$EST: each $EST emits its own TABLE / iteration block.
      // Reset initRow on each new TABLE so the LAST table's iteration-0
      // row wins (matches the "last $EST step" rule we use for finals).
      initRow = null;
      continue;
    }
    if (tokens[0] === 'ITERATION') {
      header = tokens;
      continue;
    }
    const iter = Number(tokens[0]);
    if (!Number.isFinite(iter)) continue;
    if (iter === INIT_ITER && initRow === null) initRow = tokens;
    if (iter === FINAL_SENTINEL) finalRow = tokens;
    else if (iter === SE_SENTINEL) seRow = tokens;
  }

  if (!header || !finalRow) return null;

  const finals = pickRow(header, finalRow);
  const ofv = finals.get('OBJ');
  if (ofv === undefined) return null; // truncated .ext or missing OBJ column
  finals.delete('OBJ');

  const inits = initRow ? pickRow(header, initRow) : new Map<string, number>();
  inits.delete('OBJ');

  let standardErrors = new Map<string, number>();
  if (seRow) {
    const ses = pickRow(header, seRow);
    ses.delete('OBJ');
    // Drop the row entirely when every value is zero — that's NONMEM's
    // "no $COV ran" placeholder, not a real SE.
    if ([...ses.values()].some((v) => v !== 0)) {
      standardErrors = ses;
    }
  }

  return { ofv, inits, finals, standardErrors };
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
