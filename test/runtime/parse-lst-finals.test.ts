import { describe, it, expect } from 'vitest';
import { parseLstFinals, parseLstFinalsSe } from '../../src/runtime/parse-lst-finals';

const SAMPLE_FINAL = `
1NONLINEAR MIXED EFFECTS MODEL PROGRAM ...
 ************************************************************************************************************************
 ********************                                                                                ********************
 ********************                                   FIRST ORDER                                  ********************
 ********************                             FINAL PARAMETER ESTIMATE                           ********************
 ********************                                                                                ********************
 ************************************************************************************************************************



 THETA - VECTOR OF FIXED EFFECTS PARAMETERS   *********


         TH 1      TH 2      TH 3      TH 4

         8.87E-01 -2.13E+00 -1.21E+00  1.81E-01



 OMEGA - COV MATRIX FOR RANDOM EFFECTS - ETAS  ********


         ETA1

 ETA1
+        1.00E-01



 OMEGA - CORR MATRIX FOR RANDOM EFFECTS - ETAS  *******


         ETA1

 ETA1
+        3.16E-01



 SIGMA - COV MATRIX FOR RANDOM EFFECTS - EPSILONS  ****


         EPS1

 EPS1
+        2.50E-01



 SIGMA - CORR MATRIX FOR RANDOM EFFECTS - EPSILONS  ***


         EPS1

 EPS1
+        5.00E-01
1
`;

const SAMPLE_SE = `
 ************************************************************************************************************************
 ********************                                                                                ********************
 ********************                                   FIRST ORDER                                  ********************
 ********************                            STANDARD ERROR OF ESTIMATE                          ********************
 ********************                                                                                ********************
 ************************************************************************************************************************



 THETA - VECTOR OF FIXED EFFECTS PARAMETERS   *********


         TH 1      TH 2      TH 3      TH 4

         1.81E-01  2.40E-01  1.98E-01  2.16E-02



 OMEGA - COV MATRIX FOR RANDOM EFFECTS - ETAS  ********


         ETA1

 ETA1
+       .........



 SIGMA - COV MATRIX FOR RANDOM EFFECTS - EPSILONS  ****


         EPS1

 EPS1
+        3.00E-02
1
`;

describe('parseLstFinals', () => {
  it('returns null when banner absent', () => {
    expect(parseLstFinals('no banner here')).toBeNull();
  });

  it('parses THETA finals 1-indexed by THETA(i) key', () => {
    const r = parseLstFinals(SAMPLE_FINAL)!;
    expect(r.thetas.get('THETA(1)')).toBeCloseTo(0.887, 3);
    expect(r.thetas.get('THETA(2)')).toBeCloseTo(-2.13, 2);
    expect(r.thetas.get('THETA(4)')).toBeCloseTo(0.181, 3);
    expect(r.thetas.size).toBe(4);
  });

  it('parses OMEGA COV MATRIX into lower-triangular OMEGA(i,j) map', () => {
    const r = parseLstFinals(SAMPLE_FINAL)!;
    expect(r.omegas.get('OMEGA(1,1)')).toBeCloseTo(0.1, 3);
    expect(r.omegas.size).toBe(1);
  });

  it('parses SIGMA COV MATRIX into SIGMA(i,j) map', () => {
    const r = parseLstFinals(SAMPLE_FINAL)!;
    expect(r.sigmas.get('SIGMA(1,1)')).toBeCloseTo(0.25, 3);
    expect(r.sigmas.size).toBe(1);
  });

  it('SKIPS OMEGA CORR MATRIX (we surface COV form only)', () => {
    // The COV diagonal is 0.1; the CORR diagonal in the sample is 0.316
    // (= sqrt(0.1)). If we leaked the CORR section into the map the
    // diagonal would get overwritten.
    const r = parseLstFinals(SAMPLE_FINAL)!;
    expect(r.omegas.get('OMEGA(1,1)')).toBeCloseTo(0.1, 3);
  });
});

describe('parseLstFinalsSe', () => {
  it('returns null when banner absent', () => {
    expect(parseLstFinalsSe(SAMPLE_FINAL)).toBeNull();
  });

  it('parses THETA standard errors', () => {
    const r = parseLstFinalsSe(SAMPLE_SE)!;
    expect(r.thetas.get('THETA(1)')).toBeCloseTo(0.181, 3);
    expect(r.thetas.size).toBe(4);
  });

  it('treats `.........` (NM not-computed marker) as absent — entry omitted', () => {
    const r = parseLstFinalsSe(SAMPLE_SE)!;
    // OMEGA SE is `.........` for the fixed-zero variance → absent from map.
    expect(r.omegas.has('OMEGA(1,1)')).toBe(false);
  });

  it('SIGMA SE parsed when numeric', () => {
    const r = parseLstFinalsSe(SAMPLE_SE)!;
    expect(r.sigmas.get('SIGMA(1,1)')).toBeCloseTo(0.03, 3);
  });
});

describe('FORTRAN page-break (`1` in column 0)', () => {
  // Reported via positron-nonmem 2026-05-12: a phantom OMEGA(1,2)=1.0
  // off-diagonal appeared in the Fit Inspector for a model with a
  // single OMEGA. Root cause: NONMEM's .lst inserts a bare `1` line
  // (FORTRAN form-feed marker) between OMEGA-COV and OMEGA-CORR
  // sections. The continuation-line logic was treating it as an
  // extra value for the prior ETA row.
  const WITH_PAGE_BREAK = `
 ********************                             FINAL PARAMETER ESTIMATE                           ********************


 THETA - VECTOR OF FIXED EFFECTS PARAMETERS   *********


         TH 1

         5.00E-01



 OMEGA - COV MATRIX FOR RANDOM EFFECTS - ETAS  ********


         ETA1

 ETA1
+        1.00E-01

1


 OMEGA - CORR MATRIX FOR RANDOM EFFECTS - ETAS  *******


         ETA1

 ETA1
+        3.16E-01

1
`;

  it('does NOT promote the page-break `1` into the prior ETA row as OMEGA(1,2)', () => {
    const r = parseLstFinals(WITH_PAGE_BREAK)!;
    expect(r.omegas.size).toBe(1);
    expect(r.omegas.get('OMEGA(1,1)')).toBeCloseTo(0.1, 3);
    expect(r.omegas.has('OMEGA(1,2)')).toBe(false);
  });
});
