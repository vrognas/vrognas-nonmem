// Shared FORTRAN-number parser. NONMEM emits scientific notation in
// either `E` form (default; `1.234E+02`) or `D` form when the user
// passes `$EST FORMAT=s1PD15.8` — both denote the same double. `Number()`
// only recognises `E`, so D-exponent tokens parse as NaN and rows get
// silently dropped at the next `isFinite` guard.
//
// Use this helper anywhere a parser reads numeric tokens from a
// FORTRAN-formatted file (`.ext`, `.cor`, `.cnv`, `.phi`, `.lst`
// initial-matrix echo, etc.).

/**
 * Parse a FORTRAN scientific-notation token to a JS number. Handles
 * both `E` and `D` exponents; returns NaN for any unparseable input
 * (mirroring `Number()` semantics — callers should `isFinite`-guard).
 */
export function parseFortranNumber(tok: string): number {
  return Number(tok.replace(/[dD]/, 'E'));
}
