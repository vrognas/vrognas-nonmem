// Parse `0INITIAL ESTIMATE OF OMEGA:` / `0INITIAL ESTIMATE OF SIGMA:`
// blocks from a NONMEM `.lst`. NONMEM-authoritative source for what
// was parsed from the user's `$OMEGA` / `$SIGMA` — covers BLOCK
// off-diagonals (which vscode-nmtran's parsed-model API doesn't
// expose today) and structural-zero off-diagonals from diagonal
// `$OMEGA` declarations (NONMEM emits the full lower-triangular
// matrix with 0.0 in those positions, so callers can distinguish
// "explicitly zero" from "not declared").
//
// Why we need this: the inspector's off-diagonal OMEGA/SIGMA rows
// were falling back to `.ext` iteration-0 for the initial value,
// but for SAEM the iteration-0 row is *NONMEM's perturbed starting
// matrix*, not the user's intent (NONMEM pads diagonals for
// numerical stability before SAEM begins). The `.lst` echo is the
// authoritative "user's intent, NONMEM-parsed" record.
//
// Format (verified empirically against NONMEM 7.6.0):
//
//   BLOCK form:
//     0INITIAL ESTIMATE OF OMEGA:
//      BLOCK SET NO.   BLOCK                                       FIXED
//             1                                                       NO
//                       0.1000E+00
//                       0.5000E-01   0.1000E+00
//                       0.5000E-01   0.5000E-01   0.1000E+00
//                       0.5000E-01   0.5000E-01   0.5000E-01   0.1000E+00
//     0INITIAL ESTIMATE OF SIGMA:
//
//   Diagonal form (no `BLOCK SET NO.` header — full lower-triangle
//   with 0.0 in every off-diagonal position):
//     0INITIAL ESTIMATE OF OMEGA:
//      0.1000E+00
//      0.0000E+00   0.1000E+00
//      0.0000E+00   0.0000E+00   0.1000E+00
//
// Both forms parse via the same row-counting rule: line with N
// scientific-format numbers and no other text -> row N of the lower
// triangle (`OMEGA(N,1) ... OMEGA(N,N)`).

export type MatrixKind = 'OMEGA' | 'SIGMA';

/** Map of access-key (e.g. `OMEGA(2,1)`) to initial value, lower-triangular only. */
export type InitialMatrix = Map<string, number>;

/**
 * Parse the OMEGA initial-estimate block. Returns an empty map when
 * the section isn't found (older / non-NM-TRAN .lst, missing `$OMEGA`).
 */
export function parseInitialOmega(lstText: string): InitialMatrix {
  return parseInitialMatrix(lstText, 'OMEGA');
}

/**
 * Parse the SIGMA initial-estimate block. Same semantics as OMEGA;
 * SIGMA is typically diagonal so the matrix is usually 1x1 or NxN
 * with all-zero off-diagonals.
 */
export function parseInitialSigma(lstText: string): InitialMatrix {
  return parseInitialMatrix(lstText, 'SIGMA');
}

function parseInitialMatrix(lstText: string, kind: MatrixKind): InitialMatrix {
  const values: InitialMatrix = new Map();

  // Section start: `0INITIAL ESTIMATE OF OMEGA:` (the leading `0` is
  // a Fortran carriage-control char NONMEM emits for new-page section
  // headers; our line splitter retains it).
  const startRe = new RegExp(`^0?INITIAL\\s+ESTIMATE\\s+OF\\s+${kind}\\b`, 'm');
  const startMatch = lstText.match(startRe);
  if (!startMatch || startMatch.index === undefined) return values;

  // Work on the slice from end-of-header onward.
  const after = lstText.slice(startMatch.index + startMatch[0].length);
  // Stop at the next section header (`0INITIAL ...`, `0COVARIANCE ...`,
  // `0PROBLEM NO.`, etc.). Any line starting with `0` followed by
  // an uppercase letter is treated as a section boundary.
  const stopMatch = after.match(/\n0[A-Z]/);
  const body = stopMatch && stopMatch.index !== undefined ? after.slice(0, stopMatch.index) : after;

  const NUM_RE = /[+-]?\d+\.\d+E[+-]?\d+/gi;
  let expectedRow = 1;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const nums = line.match(NUM_RE);
    if (!nums) continue;
    // Row k of the lower triangle has exactly k numeric values. Lines
    // that don't match (e.g. a stray header echoed differently in some
    // NM build) are skipped silently so we don't misalign the row
    // counter on partial matches.
    if (nums.length !== expectedRow) continue;
    for (let col = 1; col <= expectedRow; col++) {
      const v = Number(nums[col - 1]);
      if (Number.isFinite(v)) values.set(`${kind}(${expectedRow},${col})`, v);
    }
    expectedRow++;
  }
  return values;
}
