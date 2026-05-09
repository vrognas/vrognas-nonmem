import { describe, it, expect } from 'vitest';
import { parseCnv, lastCnvTable } from '../../src/runtime/parse-cnv';

// Captured verbatim from probe-signals/s1/run001.cnv on NONMEM 7.6.0
// (see docs/empirical-notes.md). Diagonal OMEGA model, so off-diag
// OMEGA(i,j) for i≠j show p=1.000 (slopes are constant zero).
const SAEM_CNV = `TABLE NO.     1: Stochastic Approximation Expectation-Maximization: Goal Function=FINAL VALUE OF LIKELIHOOD FUNCTION: Problem=1 Subproblem=0 Superproblem1=0 Iteration1=0 Superproblem2=0 Iteration2=0
 ITERATION    THETA1       THETA2       SIGMA(1,1)   OMEGA(1,1)   SAEMOBJ
  -2000000000  9.80E-01     9.62E-01     5.02E-01     3.63E-02    -37858.76
  -2000000001  5.42E-03     6.47E-03     4.61E-04     1.22E-03    107.85
  -2000000002  9.20E-01     1.01E-01     9.38E-01     9.22E-01    0.24004
  -2000000003  5.68E-03     5.68E-03     5.68E-03     5.68E-03    5.0E-02
`;

// Two-block .cnv (a chained $EST scenario: e.g. SAEM then a second
// run with CTYPE>0). Last-block-wins rule.
const TWO_BLOCKS = `TABLE NO.     1: Iterative Two Stage: Problem=1 Subproblem=0 Superproblem1=0 Iteration1=0 Superproblem2=0 Iteration2=0
 ITERATION    THETA1       SAEMOBJ
  -2000000000  1.00E+00    -100.0
  -2000000001  1.00E-02     2.0
  -2000000002  3.00E-01     5.00E-01
  -2000000003  5.00E-02     5.00E-02
TABLE NO.     2: Stochastic Approximation Expectation-Maximization: Problem=1 Subproblem=0 Superproblem1=0 Iteration1=0 Superproblem2=0 Iteration2=0
 ITERATION    THETA1       SAEMOBJ
  -2000000000  9.00E-01    -200.0
  -2000000001  1.00E-03     1.0
  -2000000002  8.00E-01     1.00E-01
  -2000000003  5.00E-02     5.00E-02
`;

describe('parseCnv', () => {
  it('parses the four marker rows into means / SDs / p-values / alphas', () => {
    const tables = parseCnv(SAEM_CNV);
    expect(tables).toHaveLength(1);
    const t = tables[0];
    expect(t.method).toContain('Stochastic Approximation Expectation-Maximization');
    expect(t.paramNames).toEqual(['THETA1', 'THETA2', 'SIGMA(1,1)', 'OMEGA(1,1)', 'SAEMOBJ']);
    expect(t.means[0]).toBeCloseTo(0.98, 3);
    expect(t.sds[2]).toBeCloseTo(4.61e-4, 6);
    // Per-param alphas Bonferroni-corrected (0.00568); OFV uncorrected (0.05).
    expect(t.alphas[0]).toBeCloseTo(5.68e-3, 5);
    expect(t.alphas[t.alphas.length - 1]).toBeCloseTo(0.05, 4);
    // OFV p-value (last column) — drives the headline verdict.
    expect(t.pValues[t.pValues.length - 1]).toBeCloseTo(0.24, 3);
  });

  it('lastCnvTable returns the FINAL $EST block (multi-block last-wins rule)', () => {
    const t = lastCnvTable(TWO_BLOCKS);
    expect(t).not.toBeNull();
    expect(t!.method).toContain('Stochastic Approximation Expectation-Maximization');
    // First block had OFV=−100; final has OFV=−200.
    expect(t!.means[t!.means.length - 1]).toBeCloseTo(-200, 1);
    // First block OFV p=0.5; final 0.1 — pick the final.
    expect(t!.pValues[t!.pValues.length - 1]).toBeCloseTo(0.1, 3);
  });

  it('returns empty array for empty / malformed / CTYPE=0-truncated input', () => {
    expect(parseCnv('')).toEqual([]);
    expect(parseCnv('garbage\nnot a cnv file')).toEqual([]);
    // Header but no marker rows (truncated mid-write):
    const truncated = `TABLE NO.     1: Foo: Problem=1
 ITERATION    THETA1       SAEMOBJ
`;
    expect(parseCnv(truncated)).toEqual([]);
    expect(lastCnvTable('')).toBeNull();
  });
});
