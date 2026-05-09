import { describe, it, expect } from 'vitest';
import { parseExtTrajectory } from '../../src/runtime/parse-ext-trajectory';

// Compact sample — a 3-iteration FOCE run. Exercises iteration retention
// + THETA1 -> THETA(1) normalisation + skipping the negative-marker rows.
const FOCE_EXT = `TABLE NO.     1: First Order Conditional Estimation with Interaction: Problem=1 Subproblem=0
 ITERATION    THETA1       OMEGA(1,1)   SIGMA(1,1)   OBJ
            0  1.00000E+00  1.00000E-01  1.00000E+00  1.00E+10
            1  1.10000E+00  1.20000E-01  1.05000E+00  -500.0
            2  1.20000E+00  1.30000E-01  1.08000E+00  -700.0
  -1000000000 1.20000E+00  1.30000E-01  1.08000E+00  -700.0
  -1000000001 1.00000E-02  5.00000E-03  2.00000E-02   0.0
`;

// SAEM with burn-in (negative iters) and accumulation (positive iters)
// chained with an IMP EONLY refinement (TABLE 2). Confirms multi-table
// behaviour + negative-iteration retention + last-table-wins helper.
const SAEM_THEN_IMP = `TABLE NO.     1: Stochastic Approximation Expectation-Maximization: Problem=1 Subproblem=0
 ITERATION    THETA1       SAEMOBJ
        -100  1.00000E+00  1.00E+05
         -90  9.50000E-01 -3.00E+04
           0  9.30000E-01 -3.50E+04
          10  9.31000E-01 -3.55E+04
  -1000000000 9.31000E-01 -3.55E+04
TABLE NO.     2: Objective Function Evaluation by Importance Sampling: Problem=1 Subproblem=0
 ITERATION    THETA1       OBJ
            0  9.31000E-01  6.66E+03
            1  9.31000E-01  6.65E+03
            2  9.31000E-01  6.66E+03
  -1000000000 9.31000E-01  6.66E+03
`;

describe('parseExtTrajectory', () => {
  it('keeps every iteration row with proper THETA normalisation; skips negative markers', () => {
    const tables = parseExtTrajectory(FOCE_EXT);
    expect(tables).toHaveLength(1);
    const t = tables[0];
    expect(t.method).toContain('First Order Conditional Estimation');
    expect(t.paramNames).toEqual(['THETA(1)', 'OMEGA(1,1)', 'SIGMA(1,1)', 'OBJ']);
    expect(t.iterations).toEqual([0, 1, 2]); // -1000000000 / -1000000001 dropped
    expect(t.values.get('THETA(1)')).toEqual([1, 1.1, 1.2]);
    expect(t.values.get('OBJ')).toEqual([1e10, -500, -700]);
  });

  it('produces one trajectory per chained $EST; preserves negative burn-in iters', () => {
    const tables = parseExtTrajectory(SAEM_THEN_IMP);
    expect(tables).toHaveLength(2);
    // Burn-in iters retained (negative); positive iters retained.
    expect(tables[0].iterations).toEqual([-100, -90, 0, 10]);
    expect(tables[0].values.get('SAEMOBJ')).toEqual([1e5, -3e4, -3.5e4, -3.55e4]);
    // IMP EONLY trajectory.
    expect(tables[1].method).toContain('Importance Sampling');
    expect(tables[1].iterations).toEqual([0, 1, 2]);
  });

  it('returns empty array for empty input', () => {
    expect(parseExtTrajectory('')).toEqual([]);
    expect(parseExtTrajectory('garbage\nnot a table')).toEqual([]);
  });
});
