// Unit tests for the WebView-side `transforms.js` pure functions.
// The file is loaded as a plain `<script>` in the inspector but
// dual-exports for Node so vitest can import its public functions.
import { describe, it, expect } from 'vitest';
// prettier-ignore
// @ts-expect-error — plain JS file with module.exports guard
import { matrixIsDiagonal, buildDiagBaseValues, transformValue } from '../../media/fit-inspector/transforms.js';

describe('matrixIsDiagonal', () => {
  it('treats matching subscripts as diagonal', () => {
    expect(matrixIsDiagonal('OMEGA(1,1)')).toBe(true);
    expect(matrixIsDiagonal('SIGMA(2,2)')).toBe(true);
  });
  it('treats mismatched subscripts as off-diagonal', () => {
    expect(matrixIsDiagonal('OMEGA(2,1)')).toBe(false);
    expect(matrixIsDiagonal('OMEGA(3,2)')).toBe(false);
  });
  it('returns false for non-matrix names', () => {
    expect(matrixIsDiagonal('THETA(1)')).toBe(false);
    expect(matrixIsDiagonal('OBJ')).toBe(false);
  });
});

describe('buildDiagBaseValues', () => {
  it('extracts diagonals only, keyed by row index', () => {
    const rows = [
      { name: 'OMEGA(1,1)', final: 0.1, init: 0.05 },
      { name: 'OMEGA(2,1)', final: 0.02, init: 0.01 },
      { name: 'OMEGA(2,2)', final: 0.2, init: 0.1 },
    ];
    const lstMode = buildDiagBaseValues(rows, true);
    expect(lstMode.get(1)).toBe(0.1);
    expect(lstMode.get(2)).toBe(0.2);
    expect(lstMode.has(3)).toBe(false);
    // mod-mode picks `init` instead of `final`.
    const modMode = buildDiagBaseValues(rows, false);
    expect(modMode.get(1)).toBe(0.05);
    expect(modMode.get(2)).toBe(0.1);
  });
  it('skips non-finite values', () => {
    const rows = [
      { name: 'OMEGA(1,1)', final: NaN, init: 0.1 },
      { name: 'OMEGA(2,2)', final: 0.5, init: 0.2 },
    ];
    expect([...buildDiagBaseValues(rows, true).keys()]).toEqual([2]);
  });
});

describe('transformValue', () => {
  const off = { sqrtOm: false, expTh: false };
  const sqrt = { sqrtOm: true, expTh: false };
  const exp = { sqrtOm: false, expTh: true };

  it('passes through when no toggle is on', () => {
    expect(transformValue(0.1, 'omega', 'OMEGA(1,1)', new Map(), off)).toBe(0.1);
    expect(transformValue(2.5, 'theta', 'THETA(1)', null, off)).toBe(2.5);
  });

  it('exp(θ) on THETA when expTh is on', () => {
    expect(transformValue(0, 'theta', 'THETA(1)', null, exp)).toBe(1);
    expect(transformValue(1, 'theta', 'THETA(1)', null, exp)).toBeCloseTo(Math.E);
  });

  it('OMEGA diagonal: variance → SD via sqrt', () => {
    expect(transformValue(0.04, 'omega', 'OMEGA(1,1)', new Map(), sqrt)).toBeCloseTo(0.2);
    // Negative variance is degenerate — return null (em-dash) rather
    // than NaN so the column stays consistent.
    expect(transformValue(-0.01, 'omega', 'OMEGA(1,1)', new Map(), sqrt)).toBeNull();
  });

  it('OMEGA off-diagonal: covariance → correlation via cov / √(var_i · var_j)', () => {
    // Diagonals are 0.04 and 0.09 → SDs 0.2, 0.3 → product 0.06.
    // Covariance 0.03 / 0.06 = 0.5 correlation.
    const diag = new Map([
      [1, 0.04],
      [2, 0.09],
    ]);
    expect(transformValue(0.03, 'omega', 'OMEGA(2,1)', diag, sqrt)).toBeCloseTo(0.5);
  });

  it('off-diagonal: returns null when either diagonal is missing/zero/negative', () => {
    // Missing diagonal:
    expect(transformValue(0.03, 'omega', 'OMEGA(2,1)', new Map([[1, 0.04]]), sqrt)).toBeNull();
    // Zero diagonal:
    expect(
      transformValue(
        0.03,
        'omega',
        'OMEGA(2,1)',
        new Map([
          [1, 0],
          [2, 0.09],
        ]),
        sqrt,
      ),
    ).toBeNull();
    // Negative diagonal:
    expect(
      transformValue(
        0.03,
        'omega',
        'OMEGA(2,1)',
        new Map([
          [1, -0.04],
          [2, 0.09],
        ]),
        sqrt,
      ),
    ).toBeNull();
  });

  it('handles non-finite input by returning null', () => {
    expect(transformValue(NaN, 'theta', 'THETA(1)', null, exp)).toBeNull();
    expect(transformValue(Infinity, 'omega', 'OMEGA(1,1)', new Map(), sqrt)).toBeNull();
    // Non-numeric:
    expect(transformValue(null, 'theta', 'THETA(1)', null, exp)).toBeNull();
  });
});
