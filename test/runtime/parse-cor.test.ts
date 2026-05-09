import { describe, it, expect } from 'vitest';
import { parseCor, lastCorTable } from '../../src/runtime/parse-cor';

const SINGLE_TABLE = `TABLE NO.     1: First Order Conditional Estimation with Interaction: Problem=1 Subproblem=0 Superproblem1=0 Iteration1=0 Superproblem2=0 Iteration2=0
 NAME         THETA1       SIGMA(1,1)   OMEGA(1,1)
 THETA1        1.00000E+00  4.20000E-01 -1.50000E-01
 SIGMA(1,1)    4.20000E-01  1.00000E+00  3.10000E-02
 OMEGA(1,1)   -1.50000E-01  3.10000E-02  1.00000E+00
`;

const TWO_TABLES = `TABLE NO.     1: Iterative Two Stage: Problem=1 Subproblem=0 Superproblem1=0 Iteration1=0 Superproblem2=0 Iteration2=0
 NAME         THETA1       OMEGA(1,1)
 THETA1        1.00000E+00  9.00000E-01
 OMEGA(1,1)    9.00000E-01  1.00000E+00
TABLE NO.     2: First Order Conditional Estimation with Interaction: Problem=1 Subproblem=0 Superproblem1=0 Iteration1=0 Superproblem2=0 Iteration2=0
 NAME         THETA1       OMEGA(1,1)
 THETA1        1.00000E+00  2.00000E-01
 OMEGA(1,1)    2.00000E-01  1.00000E+00
`;

describe('parseCor', () => {
  it('parses a single TABLE block into method + paramNames + symmetric matrix', () => {
    const tables = parseCor(SINGLE_TABLE);
    expect(tables).toHaveLength(1);
    const t = tables[0];
    expect(t.method).toContain('First Order Conditional Estimation with Interaction');
    expect(t.paramNames).toEqual(['THETA1', 'SIGMA(1,1)', 'OMEGA(1,1)']);
    expect(t.values.get('THETA1')!.get('SIGMA(1,1)')).toBeCloseTo(0.42, 5);
    expect(t.values.get('SIGMA(1,1)')!.get('THETA1')).toBeCloseTo(0.42, 5);
    expect(t.values.get('THETA1')!.get('OMEGA(1,1)')).toBeCloseTo(-0.15, 5);
    // Diagonal preserved at 1.0 — useful sanity-check for the redflag
    // helper to know the matrix is well-formed.
    expect(t.values.get('THETA1')!.get('THETA1')).toBeCloseTo(1, 5);
  });

  it('lastCorTable returns the FINAL $EST step (multi-`#METH:` last-wins rule)', () => {
    const t = lastCorTable(TWO_TABLES);
    expect(t).not.toBeNull();
    // First table had THETA1↔OMEGA = 0.9; final table has 0.2 — pick the final.
    expect(t!.method).toContain('First Order Conditional Estimation with Interaction');
    expect(t!.values.get('THETA1')!.get('OMEGA(1,1)')).toBeCloseTo(0.2, 5);
  });

  it('returns empty array when no TABLE NO. block recognised (truncated / non-cor input)', () => {
    expect(parseCor('')).toEqual([]);
    expect(parseCor('garbage\nnot a cor file')).toEqual([]);
    expect(lastCorTable('')).toBeNull();
  });
});
