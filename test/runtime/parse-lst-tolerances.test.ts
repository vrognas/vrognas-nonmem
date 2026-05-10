import { describe, it, expect } from 'vitest';
import { parseLstTolerances } from '../../src/runtime/parse-lst-tolerances';

describe('parseLstTolerances', () => {
  it('extracts BASE / EST / COV tolerance blocks + SIGL/SIGLO', () => {
    // Verbatim slice from `~/positron-nonmem/probe-resolved/atol_12/run001.lst`
    // — model $SUBROUTINES ADVAN13 TOL=6, $EST ATOL=12, bare $COV.
    const lst = `
 SIGDIGITS ETAHAT (SIGLO):                  -1
 SIGDIGITS GRADIENTS (SIGL):                -1
 INITIAL (BASE) TOLERANCE SETTINGS:
 NRD (RELATIVE) VALUE(S) OF TOLERANCE:   6
 ANRD (ABSOLUTE) VALUE(S) OF TOLERANCE:  12
 ADDITIONAL PK PARAMETERS - ASSIGNMENT OF ROWS IN GG
 NO. OF SIG. FIGURES REQUIRED:            3
 SIGDIGITS FOR MAP ESTIMATION (SIGLO):      100
 GRADIENT SIGDIGITS OF
       FIXED EFFECTS PARAMETERS (SIGL):     100
 TOLERANCES FOR ESTIMATION/EVALUATION STEP:
 NRD (RELATIVE) VALUE(S) OF TOLERANCE:   6
 ANRD (ABSOLUTE) VALUE(S) OF TOLERANCE:  12
 TOLERANCES FOR COVARIANCE STEP:
 NRD (RELATIVE) VALUE(S) OF TOLERANCE:   6
 ANRD (ABSOLUTE) VALUE(S) OF TOLERANCE:  12
`;
    const t = parseLstTolerances(lst);
    expect(t.baseNrd).toBe('6');
    expect(t.baseAnrd).toBe('12');
    expect(t.estNrd).toBe('6');
    expect(t.estAnrd).toBe('12');
    expect(t.covNrd).toBe('6');
    expect(t.covAnrd).toBe('12');
    expect(t.siglo).toBe('100');
    expect(t.sigl).toBe('100');
  });

  it('handles user-customised ATOL: BASE shows 12 (built-in), EST shows 10 (user)', () => {
    const lst = `
 INITIAL (BASE) TOLERANCE SETTINGS:
 NRD (RELATIVE) VALUE(S) OF TOLERANCE:   6
 ANRD (ABSOLUTE) VALUE(S) OF TOLERANCE:  12
 TOLERANCES FOR ESTIMATION/EVALUATION STEP:
 NRD (RELATIVE) VALUE(S) OF TOLERANCE:   6
 ANRD (ABSOLUTE) VALUE(S) OF TOLERANCE:  10
`;
    const t = parseLstTolerances(lst);
    expect(t.baseAnrd).toBe('12');
    expect(t.estAnrd).toBe('10');
  });

  it('returns nulls for blocks that were not emitted (non-ODE / no $COV)', () => {
    const lst = `
 NO. OF SIG. FIGURES REQUIRED:            3
 SIGDIGITS FOR MAP ESTIMATION (SIGLO):      100
`;
    const t = parseLstTolerances(lst);
    expect(t.baseNrd).toBeNull();
    expect(t.baseAnrd).toBeNull();
    expect(t.estNrd).toBeNull();
    expect(t.estAnrd).toBeNull();
    expect(t.covNrd).toBeNull();
    expect(t.covAnrd).toBeNull();
    expect(t.siglo).toBe('100');
    expect(t.sigl).toBeNull();
  });

  it('handles empty .lst', () => {
    const t = parseLstTolerances('');
    expect(t.baseAnrd).toBeNull();
    expect(t.estAnrd).toBeNull();
    expect(t.covAnrd).toBeNull();
  });

  it('extracts decimal and scientific-notation values', () => {
    const lst = `
 INITIAL (BASE) TOLERANCE SETTINGS:
 NRD (RELATIVE) VALUE(S) OF TOLERANCE:   1.5
 ANRD (ABSOLUTE) VALUE(S) OF TOLERANCE:  1e-12
`;
    const t = parseLstTolerances(lst);
    expect(t.baseNrd).toBe('1.5');
    expect(t.baseAnrd).toBe('1e-12');
  });
});
