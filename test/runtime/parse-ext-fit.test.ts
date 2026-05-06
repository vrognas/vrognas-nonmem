import { describe, it, expect } from 'vitest';
import { parseExtFit } from '../../src/runtime/parse-ext-fit';

// Representative psn.ext (single $TABLE, FOCEI). Header columns match
// what NONMEM 7 emits: THETA<i> (no parens), OMEGA(i,j), SIGMA(i,j),
// OBJ at the end. Iteration sentinels:
//   -1000000000  final estimates
//   -1000000001  standard errors (0 when $COV didn't run)
//   -1000000002+ covariance / correlation matrices (we ignore)
const EXT_WITH_COV = `TABLE NO.  1: First Order Conditional Estimation with Interaction
 ITERATION    THETA1       THETA2       OMEGA(1,1)   OMEGA(2,1)   OMEGA(2,2)   SIGMA(1,1)   OBJ
            0   1.0000E+00   1.0000E+00   1.0000E-01   0.0000E+00   1.0000E-01   1.0000E+00   1.7976E+308
            1   1.5000E+00   1.5000E+00   8.0000E-02   0.0000E+00   1.5000E-01   8.0000E-01   -5.0000E+02
 -1000000000   2.5230E+00   1.9620E+00   1.8430E-01   0.0000E+00   2.1040E-01   4.1100E-02   -6.3879E+02
 -1000000001   1.2300E-01   8.7000E-02   2.5000E-02   0.0000E+00   3.5000E-02   8.0100E-03   0.0000E+00
 -1000000002   1.5129E-02   ...
`;

const EXT_NO_COV = `TABLE NO.  1: First Order Conditional Estimation
 ITERATION    THETA1       OMEGA(1,1)   SIGMA(1,1)   OBJ
            0   1.0000E+00   1.0000E-01   1.0000E+00   1.7976E+308
 -1000000000   2.5230E+00   1.8430E-01   4.1100E-02   -6.3879E+02
 -1000000001   0.0000E+00   0.0000E+00   0.0000E+00   0.0000E+00
`;

describe('parseExtFit', () => {
  it('extracts final estimates + SEs keyed by our access-key convention', () => {
    const fit = parseExtFit(EXT_WITH_COV);
    expect(fit).not.toBeNull();
    expect(fit!.ofv).toBeCloseTo(-638.79, 1);
    // THETA columns map THETA1/THETA2/... → THETA(1)/THETA(2)/...
    expect(fit!.finals.get('THETA(1)')).toBeCloseTo(2.523, 3);
    expect(fit!.finals.get('THETA(2)')).toBeCloseTo(1.962, 3);
    // OMEGA / SIGMA columns pass through verbatim.
    expect(fit!.finals.get('OMEGA(1,1)')).toBeCloseTo(0.1843, 3);
    expect(fit!.finals.get('OMEGA(2,2)')).toBeCloseTo(0.2104, 3);
    expect(fit!.finals.get('SIGMA(1,1)')).toBeCloseTo(0.0411, 3);
    // SEs alongside.
    expect(fit!.standardErrors.get('THETA(1)')).toBeCloseTo(0.123, 3);
    expect(fit!.standardErrors.get('OMEGA(2,2)')).toBeCloseTo(0.035, 3);
  });

  it('treats all-zero SE row as "no SE available" ($COV step skipped or failed)', () => {
    const fit = parseExtFit(EXT_NO_COV);
    expect(fit).not.toBeNull();
    expect(fit!.finals.get('THETA(1)')).toBeCloseTo(2.523, 3);
    // SEs map is empty (or all-zero entries dropped) — caller can render
    // "—" instead of "SE 0" which would be misleading.
    expect(fit!.standardErrors.size).toBe(0);
  });

  it('returns null when the .ext has no -1000000000 row (run aborted before convergence)', () => {
    const noFinal = `TABLE NO.  1
 ITERATION    THETA1   OBJ
            0   1.0   100.5
            1   1.5   50.5
`;
    expect(parseExtFit(noFinal)).toBeNull();
  });

  it('skips off-diagonal OMEGA/SIGMA entries (we only display diagonals)', () => {
    const fit = parseExtFit(EXT_WITH_COV);
    // OMEGA(2,1) is off-diagonal — caller shouldn't see it as a key it
    // tries to render. The parser keeps it in the map (so future
    // chunks rendering BLOCK matrices have the data) — caller filters
    // by access-key match against our diagonal-only Variables-pane rows.
    expect(fit!.finals.has('OMEGA(2,1)')).toBe(true);
    expect(fit!.finals.get('OMEGA(2,1)')).toBe(0);
  });
});
