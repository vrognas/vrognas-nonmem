import { describe, it, expect } from 'vitest';
import { parseFortranNumber } from '../../src/runtime/parse-fortran-number';

describe('parseFortranNumber', () => {
  it('parses E-exponent (NONMEM default)', () => {
    expect(parseFortranNumber('1.234E+02')).toBe(123.4);
    expect(parseFortranNumber('-1.5E-03')).toBe(-0.0015);
  });

  it('parses D-exponent (FORMAT=s1PD15.8 user override)', () => {
    expect(parseFortranNumber('1.234D+02')).toBe(123.4);
    expect(parseFortranNumber('-1.5D-03')).toBe(-0.0015);
    expect(parseFortranNumber('1.0d+00')).toBe(1);
  });

  it('parses plain decimals and integers unchanged', () => {
    expect(parseFortranNumber('0.5')).toBe(0.5);
    expect(parseFortranNumber('-42')).toBe(-42);
    expect(parseFortranNumber('0')).toBe(0);
  });

  it('returns NaN for unparseable tokens', () => {
    expect(parseFortranNumber('foo')).toBeNaN();
    expect(parseFortranNumber('1.2.3')).toBeNaN();
    // `Number('')` returns 0 (JS quirk) — callers `isFinite`-guard so
    // this isn't a hazard, but lock the contract here.
    expect(parseFortranNumber('')).toBe(0);
  });
});
