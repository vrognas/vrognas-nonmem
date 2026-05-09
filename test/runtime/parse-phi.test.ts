import { describe, it, expect } from 'vitest';
import { parsePhi, lastPhiTable } from '../../src/runtime/parse-phi';

// Representative .phi (single TABLE, IT2S). One row per subject.
// Header layout: SUBJECT_NO ID PHI(1) ... PHC(i,j) ... OBJ
//   - PHI(n)   : individual ETA estimates (one per OMEGA diagonal)
//   - PHC(i,j) : conditional covariance lower triangular (NETA × NETA)
//   - OBJ      : individual OFV (iOFV) — the "driving the fit" signal
const PHI_SINGLE = `TABLE NO.     1: Iterative Two Stage: Problem=1 Subproblem=0 Superproblem1=0 Iteration1=0 Superproblem2=0 Iteration2=0
 SUBJECT_NO   ID           PHI(1)       PHI(2)       PHC(1,1)     PHC(2,1)     PHC(2,2)     OBJ
            1            1  5.81557E-01  1.27317E-01  4.80462E-03 -1.15197E-03  1.30619E-03    9.9250363260739487
            2            2  7.83107E-01  1.60253E-01  3.17898E-03 -7.78673E-04  1.30912E-03    17.423102000004185
            3            3  4.95012E-01  5.79998E-02  5.01001E-03 -1.19335E-03  1.30579E-03    11.496624847928359
            4            4  7.35370E-01  1.42929E-01  3.42577E-03 -8.41876E-04  1.30870E-03    13.326685456505004
            5            5  8.12629E-01  1.66677E-01  3.00351E-03 -7.31839E-04  1.30940E-03    14.811543356862037
`;

// Multi-table: SAEM emits SAEMOBJ as the iOFV column header, then a
// follow-on Importance Sampling step emits OBJ. The "final" iOFV per the
// last-$EST-wins rule is the IS table.
const PHI_MULTI = `TABLE NO.     1: Stochastic Approximation Expectation-Maximization: Problem=1 Subproblem=0 Superproblem1=0 Iteration1=0 Superproblem2=0 Iteration2=0
 SUBJECT_NO   ID           PHI(1)       PHI(2)       PHC(1,1)     PHC(2,1)     PHC(2,2)     SAEMOBJ
            1            1  1.15249E-01  2.71549E-02  2.86301E-05 -7.27404E-06  7.60014E-06    1718.6976973627422
            2            2  3.16001E-01  6.22508E-02  2.18702E-05 -4.87436E-06  7.41555E-06    2984.6812333070352
TABLE NO.     2: Objective Function Evaluation by Importance Sampling: Problem=1 Subproblem=0 Superproblem1=0 Iteration1=0 Superproblem2=0 Iteration2=0
 SUBJECT_NO   ID           PHI(1)       PHI(2)       PHC(1,1)     PHC(2,1)     PHC(2,2)     OBJ
            1            1  1.15296E-01  2.71327E-02  2.88199E-05 -7.03922E-06  7.34205E-06    1738.9092649349518
            2            2  3.15856E-01  6.22312E-02  2.20211E-05 -4.83100E-06  7.36204E-06    3014.8812333070352
`;

// Truncated / odd file: header missing OBJ-like trailing column entirely.
// Should still parse rows but with iOfv = null. (Defensive — the format
// is consistent in practice but our parser shouldn't throw.)
const PHI_NO_OBJ = `TABLE NO.     1: Some Method
 SUBJECT_NO   ID           PHI(1)       PHC(1,1)
            1            1  5.81557E-01  4.80462E-03
            2            2  7.83107E-01  3.17898E-03
`;

describe('parsePhi', () => {
  it('parses a single-table .phi: per-subject ETAs and iOFV', () => {
    const tables = parsePhi(PHI_SINGLE);
    expect(tables).toHaveLength(1);
    const t = tables[0];
    expect(t.method).toMatch(/Iterative Two Stage/);
    expect(t.rows).toHaveLength(5);
    expect(t.rows[0]).toMatchObject({ id: 1, etas: [0.581557, 0.127317] });
    expect(t.rows[0].iOfv).toBeCloseTo(9.92503, 4);
    expect(t.rows[4].iOfv).toBeCloseTo(14.81154, 4);
    // Sum of iOFV ≈ total OFV (sans constant): 67.0 here.
    const total = t.rows.reduce((acc, r) => acc + (r.iOfv ?? 0), 0);
    expect(total).toBeCloseTo(67.0, 1);
  });

  it('parses multi-table; lastPhiTable returns the final $EST step (last-wins)', () => {
    const tables = parsePhi(PHI_MULTI);
    expect(tables).toHaveLength(2);
    expect(tables[0].method).toMatch(/SAEM|Stochastic Approximation/);
    expect(tables[1].method).toMatch(/Importance Sampling/);

    // SAEMOBJ vs OBJ both treated as iOFV (last numeric column).
    expect(tables[0].rows[0].iOfv).toBeCloseTo(1718.7, 1);
    expect(tables[1].rows[0].iOfv).toBeCloseTo(1738.9, 1);

    // last-wins: caller helper picks the final-step table.
    const last = lastPhiTable(PHI_MULTI);
    expect(last?.method).toMatch(/Importance Sampling/);
    expect(last?.rows[0].iOfv).toBeCloseTo(1738.9, 1);
  });

  it('header without OBJ-like column → iOfv null, rows still parsed', () => {
    const tables = parsePhi(PHI_NO_OBJ);
    expect(tables).toHaveLength(1);
    expect(tables[0].rows).toHaveLength(2);
    expect(tables[0].rows[0]).toMatchObject({ id: 1, iOfv: null });
    expect(tables[0].rows[0].etas).toEqual([0.581557]);
  });
});
