import { describe, it, expect } from 'vitest';
import { parseInitialOmega, parseInitialSigma } from '../../src/runtime/parse-initial-matrix';

// Captured verbatim from probe-signals/baseline/run001.lst on NONMEM
// 7.6.0 (a $OMEGA BLOCK(4) model). Confirms BLOCK off-diagonals are
// recoverable from the .lst echo.
const BLOCK_LST = `0INITIAL ESTIMATE OF OMEGA:
 BLOCK SET NO.   BLOCK                                                                    FIXED
        1                                                                                   NO
                  0.1000E+00
                  0.5000E-01   0.1000E+00
                  0.5000E-01   0.5000E-01   0.1000E+00
                  0.5000E-01   0.5000E-01   0.5000E-01   0.1000E+00
0INITIAL ESTIMATE OF SIGMA:
 0.1000E+01
0COVARIANCE STEP OMITTED:        NO
`;

// Diagonal $OMEGA — NONMEM emits the full lower triangle with 0.0
// in every off-diagonal position (verified against probe-signals/s1).
const DIAGONAL_LST = `0INITIAL ESTIMATE OF OMEGA:
 0.1000E+00
 0.0000E+00   0.1000E+00
 0.0000E+00   0.0000E+00   0.1000E+00
 0.0000E+00   0.0000E+00   0.0000E+00   0.1000E+00
0INITIAL ESTIMATE OF SIGMA:
 0.1000E+01
0COVARIANCE STEP OMITTED:        NO
`;

describe('parseInitialOmega / parseInitialSigma', () => {
  it('parses BLOCK off-diagonals from the .lst INITIAL ESTIMATE echo', () => {
    const omega = parseInitialOmega(BLOCK_LST);
    expect(omega.size).toBe(10); // lower triangle of 4x4
    // Diagonals
    expect(omega.get('OMEGA(1,1)')).toBeCloseTo(0.1, 5);
    expect(omega.get('OMEGA(2,2)')).toBeCloseTo(0.1, 5);
    expect(omega.get('OMEGA(4,4)')).toBeCloseTo(0.1, 5);
    // Off-diagonals — every cell under the diagonal is 0.05 in the source model.
    expect(omega.get('OMEGA(2,1)')).toBeCloseTo(0.05, 5);
    expect(omega.get('OMEGA(3,2)')).toBeCloseTo(0.05, 5);
    expect(omega.get('OMEGA(4,1)')).toBeCloseTo(0.05, 5);
    expect(omega.get('OMEGA(4,3)')).toBeCloseTo(0.05, 5);
    // SIGMA section parses as a 1×1 lower triangle.
    const sigma = parseInitialSigma(BLOCK_LST);
    expect(sigma.size).toBe(1);
    expect(sigma.get('SIGMA(1,1)')).toBeCloseTo(1.0, 5);
  });

  it('parses diagonal $OMEGA (off-diagonals come back as explicit 0.0)', () => {
    const omega = parseInitialOmega(DIAGONAL_LST);
    expect(omega.size).toBe(10);
    expect(omega.get('OMEGA(1,1)')).toBeCloseTo(0.1, 5);
    expect(omega.get('OMEGA(4,4)')).toBeCloseTo(0.1, 5);
    // Structural zeros — preserved verbatim so the inspector can
    // distinguish "explicitly zero" from "not declared".
    expect(omega.get('OMEGA(2,1)')).toBe(0);
    expect(omega.get('OMEGA(3,2)')).toBe(0);
    expect(omega.get('OMEGA(4,3)')).toBe(0);
  });

  it('returns empty map when the section is missing or text is non-NM7', () => {
    expect(parseInitialOmega('').size).toBe(0);
    expect(parseInitialOmega('garbage\nno section').size).toBe(0);
    expect(parseInitialSigma('').size).toBe(0);
  });
});
