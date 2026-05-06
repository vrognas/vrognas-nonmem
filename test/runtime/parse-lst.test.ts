import { describe, it, expect } from 'vitest';
import { parseLst, shortMethodLabel } from '../../src/runtime/parse-lst';

const FOCE_INTER = `
 #METH: First Order Conditional Estimation with Interaction

 #OBJT:**** OBJECTIVE FUNCTION VALUE WITHOUT CONSTANT ****

 #OBJV:********************************************    -638.7950       *************************************************

 #TERM:
 0MINIMIZATION SUCCESSFUL
 NO. OF FUNCTION EVALUATIONS USED:      213
 NO. OF SIG. DIGITS IN FINAL EST.:  3.4
 ETABAR IS THE ARITHMETIC MEAN OF THE ETA-ESTIMATES,

 #TERE:
 Elapsed estimation  time in seconds:    27.45
`;

const FOCE_TERMINATED = `
 #METH: First Order Conditional Estimation

 #TERM:
 0MINIMIZATION TERMINATED
 DUE TO ROUNDING ERRORS (ERROR=134)
 NO. OF FUNCTION EVALUATIONS USED:     999
 NO. OF SIG. DIGITS UNREPORTABLE
`;

const MULTI_EST = `
 #METH: Iterative Two Stage
 #TERM:
 NO. OF SIG. DIGITS IN FINAL EST.:  2.0
 #TERE:

 #METH: First Order Conditional Estimation with Interaction
 #TERM:
 0MINIMIZATION SUCCESSFUL
 NO. OF SIG. DIGITS IN FINAL EST.:  4.5
 #TERE:
`;

describe('parseLst', () => {
  it('extracts method label and sig-digits from a converged FOCE-INTER run', () => {
    const r = parseLst(FOCE_INTER);
    expect(r.method).toBe('First Order Conditional Estimation with Interaction');
    expect(r.sigDigits).toBeCloseTo(3.4, 2);
  });

  it('returns sigDigits=null when NONMEM writes "UNREPORTABLE" (failed minimization)', () => {
    const r = parseLst(FOCE_TERMINATED);
    expect(r.method).toBe('First Order Conditional Estimation');
    expect(r.sigDigits).toBeNull();
  });

  it('takes the LAST $EST block when multiple methods are chained (ITS → FOCE-INTER)', () => {
    const r = parseLst(MULTI_EST);
    expect(r.method).toBe('First Order Conditional Estimation with Interaction');
    expect(r.sigDigits).toBeCloseTo(4.5, 2);
  });

  it('returns null fields when no #METH:/sig-digits markers are present', () => {
    const r = parseLst('NM-TRAN MESSAGES\n\n  WARNINGS AND ERRORS\n');
    expect(r.method).toBeNull();
    expect(r.sigDigits).toBeNull();
  });
});

const FOCE_FULL_DIAGNOSTICS = `
 #METH: First Order Conditional Estimation with Interaction

 #TERM:
 0MINIMIZATION SUCCESSFUL
 NO. OF FUNCTION EVALUATIONS USED:    1234
 NO. OF SIG. DIGITS IN FINAL EST.:  3.4
 ETABAR IS THE ARITHMETIC MEAN OF THE ETA-ESTIMATES,
 AND THE P-VALUE IS GIVEN FOR THE NULL HYPOTHESIS THAT THE TRUE MEAN IS 0.

 ETABAR:        -1.2345E-02  4.5678E-02  -3.4567E-03
 SE:             8.7654E-03  6.5432E-03   2.3456E-03

 P VAL.:         1.5678E-01  4.5678E-02  9.8765E-01

 ETASHRINKSD(%)  2.3456E+00  4.6789E+00  1.2345E+01
 ETASHRINKVR(%)  4.6234E+00  9.1234E+00  2.4567E+01
 EBVSHRINKSD(%)  1.2345E+00  2.3456E+00  6.7890E+00
 EBVSHRINKVR(%)  2.4567E+00  4.6234E+00  1.3456E+01
 EPSSHRINKSD(%)  3.4567E+00
 EPSSHRINKVR(%)  6.7890E+00

 #TERE:
 Elapsed estimation  time in seconds:    27.45
 Elapsed covariance  time in seconds:     8.20

 EIGENVALUES OF COR MATRIX OF ESTIMATE

            1         2         3

        9.0010E-01  1.0010E+00  1.0980E+00
`;

const FOCE_TERMINATED_REASON = `
 #METH: First Order Conditional Estimation

 #TERM:
 0MINIMIZATION TERMINATED
 DUE TO ROUNDING ERRORS (ERROR=134)
 NO. OF FUNCTION EVALUATIONS USED:     999
 NO. OF SIG. DIGITS UNREPORTABLE
`;

describe('parseLst — diagnostics fields', () => {
  it('extracts termination state and reason', () => {
    expect(parseLst(FOCE_FULL_DIAGNOSTICS).termination).toBe('SUCCESSFUL');
    expect(parseLst(FOCE_FULL_DIAGNOSTICS).terminationReason).toBeNull();
    const t = parseLst(FOCE_TERMINATED_REASON);
    expect(t.termination).toBe('TERMINATED');
    expect(t.terminationReason).toContain('DUE TO ROUNDING ERRORS');
  });

  it('extracts ETABAR per-ETA values', () => {
    const r = parseLst(FOCE_FULL_DIAGNOSTICS);
    expect(r.etabar).toHaveLength(3);
    expect(r.etabar[0]).toBeCloseTo(-0.012345, 5);
    expect(r.etabar[1]).toBeCloseTo(0.045678, 5);
    expect(r.etabar[2]).toBeCloseTo(-0.0034567, 5);
  });

  it('extracts ETASHRINKSD(%) and EPSSHRINKSD(%) per-component', () => {
    const r = parseLst(FOCE_FULL_DIAGNOSTICS);
    expect(r.etaShrinkSd).toHaveLength(3);
    expect(r.etaShrinkSd[0]).toBeCloseTo(2.3456, 3);
    expect(r.etaShrinkSd[2]).toBeCloseTo(12.345, 3);
    expect(r.epsShrinkSd).toHaveLength(1);
    expect(r.epsShrinkSd[0]).toBeCloseTo(3.4567, 3);
  });

  it('extracts eigenvalues (skipping the column-index row above them)', () => {
    const r = parseLst(FOCE_FULL_DIAGNOSTICS);
    expect(r.eigenvalues).toHaveLength(3);
    expect(r.eigenvalues[0]).toBeCloseTo(0.9001, 3);
    expect(r.eigenvalues[1]).toBeCloseTo(1.001, 3);
    expect(r.eigenvalues[2]).toBeCloseTo(1.098, 3);
  });

  it('captures ETABAR continuation lines (NONMEM wraps when N_ETAs > ~6)', () => {
    // Real-world fixture from a 9-ETA model — ETABAR/SE/PVAL each
    // span two lines; ETASHRINKSD likewise. Whitespace alignment is
    // taken verbatim from a probed .lst.
    const text = `
 #METH: First Order Conditional Estimation with Interaction
 #TERM:
 0MINIMIZATION SUCCESSFUL
 ETABAR:        -1.0000E-02  2.0000E-02  -3.0000E-02  4.0000E-02  -5.0000E-02  6.0000E-02
                 7.0000E-02  -8.0000E-02   9.0000E-02

 SE:             1.1000E-03  1.2000E-03   1.3000E-03  1.4000E-03   1.5000E-03  1.6000E-03
                 1.7000E-03  1.8000E-03   1.9000E-03

 ETASHRINKSD(%)  1.0000E+00  2.0000E+00   3.0000E+00  4.0000E+00   5.0000E+00  6.0000E+00
                 7.0000E+00  8.0000E+00   9.0000E+00

 EPSSHRINKSD(%)  1.5000E+00  2.5000E+00

 #TERE:
`;
    const r = parseLst(text);
    expect(r.etabar).toHaveLength(9);
    expect(r.etabar[0]).toBeCloseTo(-0.01, 5);
    expect(r.etabar[8]).toBeCloseTo(0.09, 5);
    expect(r.etaShrinkSd).toHaveLength(9);
    expect(r.etaShrinkSd[0]).toBeCloseTo(1, 3);
    expect(r.etaShrinkSd[8]).toBeCloseTo(9, 3);
    // EPSSHRINKSD only had a single-line value — must NOT swallow
    // the next labelled line's values.
    expect(r.epsShrinkSd).toEqual([1.5, 2.5]);
  });

  it('stops continuation walk at the next labelled line even without an intervening blank', () => {
    const text = `
 #METH: FOCE
 ETABAR:        1.0  2.0  3.0
 SE:            0.1  0.2  0.3
 ETASHRINKSD(%) 5.0  6.0  7.0
`;
    const r = parseLst(text);
    expect(r.etabar).toEqual([1, 2, 3]);
    expect(r.etaShrinkSd).toEqual([5, 6, 7]);
  });

  it('recognises OPTIMIZATION WAS COMPLETED (SAEM / IMP / BAYES success)', () => {
    const text = `
 #METH: Stochastic Approximation Expectation-Maximization

 #TERM:
 0OPTIMIZATION WAS COMPLETED
 ITERATIVE LOOP 1: Mean Acceptance Rate: 0.40
 ITERATIVE LOOP 2: Mean Acceptance Rate: 0.41
 ITERATIVE LOOP 3: Mean Acceptance Rate: 0.42

 #TERE:
`;
    const r = parseLst(text);
    expect(r.method).toBe('Stochastic Approximation Expectation-Maximization');
    expect(r.methodShort).toBe('SAEM');
    expect(r.termination).toBe('SUCCESSFUL');
    expect(r.terminationPhrase).toBe('OPTIMIZATION WAS COMPLETED');
    // Acceptance rate: takes the LAST value (the stationary rate after burn-in).
    expect(r.acceptanceRate).toBeCloseTo(0.42, 2);
  });

  it('recognises OPTIMIZATION TERMINATED (e.g. SAEM aborted) with reason text', () => {
    const text = `
 #METH: Stochastic Approximation Expectation-Maximization

 #TERM:
 0OPTIMIZATION TERMINATED
 DUE TO PROPOSAL DENSITY DEGENERACY
 NO. OF SIG. DIGITS UNREPORTABLE
`;
    const r = parseLst(text);
    expect(r.termination).toBe('TERMINATED');
    expect(r.terminationPhrase).toBe('OPTIMIZATION TERMINATED');
    expect(r.terminationReason).toContain('DUE TO PROPOSAL DENSITY DEGENERACY');
  });

  it('preserves the verbatim "MINIMIZATION SUCCESSFUL" phrase for FOCE runs (display detail)', () => {
    expect(parseLst(FOCE_INTER).terminationPhrase).toBe('MINIMIZATION SUCCESSFUL');
  });

  it('reads per-parameter NUMSIGDIG (single line + continuation)', () => {
    // Real-world fixture from probe-psn/slow on qphcmp03 — 4 THETAs +
    // 10-element OMEGA BLOCK + 1 SIGMA = 15 values across two lines.
    const text = `
 #METH: First Order Conditional Estimation with Interaction
 NUMSIGDIG:         9.2         9.2         8.6         9.3         8.6         9.2         8.7         8.5         8.9         7.9
                    8.5         8.7         8.8         8.6         8.8

 #TERE:
`;
    const r = parseLst(text);
    expect(r.numSigDigPerParam).toHaveLength(15);
    expect(r.numSigDigPerParam[0]).toBeCloseTo(9.2, 2);
    expect(r.numSigDigPerParam[9]).toBeCloseTo(7.9, 2);
    expect(r.numSigDigPerParam[10]).toBeCloseTo(8.5, 2); // first continuation value
    expect(r.numSigDigPerParam[14]).toBeCloseTo(8.8, 2);
  });

  it('returns empty arrays / null when the lst lacks diagnostic blocks (run failed early)', () => {
    const r = parseLst('NM-TRAN MESSAGES\n\n  WARNINGS AND ERRORS\n');
    expect(r.termination).toBeNull();
    expect(r.terminationPhrase).toBeNull();
    expect(r.terminationReason).toBeNull();
    expect(r.etabar).toEqual([]);
    expect(r.etaShrinkSd).toEqual([]);
    expect(r.epsShrinkSd).toEqual([]);
    expect(r.eigenvalues).toEqual([]);
    expect(r.acceptanceRate).toBeNull();
    expect(r.numSigDigPerParam).toEqual([]);
  });
});

describe('shortMethodLabel', () => {
  it('compresses common method names to compact display labels', () => {
    expect(shortMethodLabel('First Order Conditional Estimation with Interaction')).toBe(
      'FOCE-INTER',
    );
    expect(shortMethodLabel('First Order Conditional Estimation')).toBe('FOCE');
    expect(shortMethodLabel('First Order')).toBe('FO');
    expect(shortMethodLabel('Iterative Two Stage')).toBe('ITS');
    expect(shortMethodLabel('Stochastic Approximation Expectation-Maximization')).toBe('SAEM');
    expect(shortMethodLabel('Importance Sampling')).toBe('IMP');
    expect(shortMethodLabel('MCMC Bayesian Analysis')).toBe('BAYES');
  });

  it('passes through unknown method strings unchanged', () => {
    expect(shortMethodLabel('Some Unrecognised Method')).toBe('Some Unrecognised Method');
  });

  it('returns null when given null', () => {
    expect(shortMethodLabel(null)).toBeNull();
  });
});
