import { describe, it, expect } from 'vitest';
import { parseExtFit } from '../../src/runtime/parse-ext-fit';

// Representative psn.ext (single $TABLE, FOCEI). Header columns match
// what NONMEM 7 emits: THETA<i> (no parens), OMEGA(i,j), SIGMA(i,j),
// OBJ at the end. Iteration sentinels:
//   -1000000000  final estimates
//   -1000000001  standard errors (variance form; 0 when $COV didn't run)
//   -1000000002  eigenvalues (we read these from the .lst instead)
//   -1000000003  condition number + eigen bounds (sumo has it)
//   -1000000004  OMEGA/SIGMA in SD/correlation form
//   -1000000005  SE matched to -1000000004
//   -1000000006  FIX flags (1 = fixed, 0 = estimated)
//   -1000000007  termination codes per $EST
//   -1000000008  partial derivatives (we ignore)
const EXT_WITH_COV = `TABLE NO.  1: First Order Conditional Estimation with Interaction
 ITERATION    THETA1       THETA2       OMEGA(1,1)   OMEGA(2,1)   OMEGA(2,2)   SIGMA(1,1)   OBJ
            0   1.0000E+00   1.0000E+00   1.0000E-01   0.0000E+00   1.0000E-01   1.0000E+00   1.7976E+308
            1   1.5000E+00   1.5000E+00   8.0000E-02   0.0000E+00   1.5000E-01   8.0000E-01   -5.0000E+02
 -1000000000   2.5230E+00   1.9620E+00   1.8430E-01   0.0000E+00   2.1040E-01   4.1100E-02   -6.3879E+02
 -1000000001   1.2300E-01   8.7000E-02   2.5000E-02   0.0000E+00   3.5000E-02   8.0100E-03   0.0000E+00
 -1000000002   1.5129E-02   1.0000E+00   2.0000E-01   0.0000E+00   3.0000E-01   1.0000E+00   0.0000E+00
 -1000000004   2.5230E+00   1.9620E+00   4.2930E-01   0.0000E+00   4.5870E-01   2.0270E-01   0.0000E+00
 -1000000005   1.2300E-01   8.7000E-02   2.9100E-02   0.0000E+00   3.8200E-02   1.9750E-02   0.0000E+00
 -1000000006   0.0000E+00   0.0000E+00   0.0000E+00   1.0000E+00   0.0000E+00   1.0000E+00   0.0000E+00
 -1000000007   0.0000E+00   0.0000E+00   0.0000E+00   0.0000E+00   0.0000E+00   0.0000E+00   0.0000E+00
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

  it('extracts authoritative SD/correlation form from -1000000004 / -1000000005', () => {
    const fit = parseExtFit(EXT_WITH_COV);
    expect(fit).not.toBeNull();
    // OMEGA(1,1) variance 0.1843 → NONMEM-emitted SD √0.1843 ≈ 0.4293.
    // We don't recompute; we read it.
    expect(fit!.finalsStdcorr.get('OMEGA(1,1)')).toBeCloseTo(0.4293, 3);
    expect(fit!.finalsStdcorr.get('OMEGA(2,2)')).toBeCloseTo(0.4587, 3);
    // SIGMA(1,1) variance 0.0411 → SD √0.0411 ≈ 0.2027.
    expect(fit!.finalsStdcorr.get('SIGMA(1,1)')).toBeCloseTo(0.2027, 3);
    // THETA columns pass through unchanged on the SD/corr row.
    expect(fit!.finalsStdcorr.get('THETA(1)')).toBeCloseTo(2.523, 3);
    // Matched SEs from -1000000005.
    expect(fit!.standardErrorsStdcorr.get('OMEGA(1,1)')).toBeCloseTo(0.0291, 3);
    expect(fit!.standardErrorsStdcorr.get('SIGMA(1,1)')).toBeCloseTo(0.01975, 3);
  });

  it('extracts FIX flags from -1000000006 (1=fixed, 0=estimated)', () => {
    const fit = parseExtFit(EXT_WITH_COV);
    // In the fixture, OMEGA(2,1) and SIGMA(1,1) are flagged FIX (1.0).
    expect(fit!.fixedFlags.get('OMEGA(2,1)')).toBe(true);
    expect(fit!.fixedFlags.get('SIGMA(1,1)')).toBe(true);
    expect(fit!.fixedFlags.get('THETA(1)')).toBe(false);
    expect(fit!.fixedFlags.get('OMEGA(1,1)')).toBe(false);
  });

  it('extracts termination codes from -1000000007 row', () => {
    const fit = parseExtFit(EXT_WITH_COV);
    // Fixture: all-zero codes (successful). Length = number of $EST steps.
    // We surface integer codes; non-integer junk is filtered out.
    expect(fit!.terminationCodes.length).toBeGreaterThan(0);
    expect(fit!.terminationCodes.every((c) => c === 0)).toBe(true);
  });

  it('multi-$EST: each TABLE resets all captured rows, last $EST wins', () => {
    // Earlier $EST emits stdcorr; later $EST doesn't. The later TABLE
    // header MUST clear the prior stdcorr rows, otherwise the earlier
    // step's values leak forward as if they were the final-step's.
    const text = `TABLE NO.  1: SAEM
 ITERATION    THETA1   OMEGA(1,1)   OBJ
            0   1.0E+00   1.0E-01   1.7976E+308
 -1000000000   2.0E+00   2.0E-01   -100
 -1000000004   2.0E+00   4.5E-01   0
 -1000000005   1.0E-01   3.0E-02   0
TABLE NO.  2: IMP EONLY
 ITERATION    THETA1   OMEGA(1,1)   OBJ
            0   2.0E+00   2.0E-01   -100
 -1000000000   3.0E+00   3.0E-01   -150
`;
    const fit = parseExtFit(text);
    expect(fit).not.toBeNull();
    // Last TABLE's finals win.
    expect(fit!.finals.get('THETA(1)')).toBeCloseTo(3.0, 5);
    // Stdcorr was emitted in TABLE 1 but NOT in TABLE 2 — should be empty,
    // not leaked from TABLE 1.
    expect(fit!.finalsStdcorr.size).toBe(0);
    expect(fit!.standardErrorsStdcorr.size).toBe(0);
  });

  it('returns empty stdcorr / fix / term-codes when those rows are absent (older NONMEM)', () => {
    const fit = parseExtFit(EXT_NO_COV);
    expect(fit).not.toBeNull();
    expect(fit!.finalsStdcorr.size).toBe(0);
    expect(fit!.standardErrorsStdcorr.size).toBe(0);
    expect(fit!.fixedFlags.size).toBe(0);
    expect(fit!.terminationCodes).toEqual([]);
  });
});
