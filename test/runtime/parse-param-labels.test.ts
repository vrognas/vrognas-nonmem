import { describe, it, expect } from 'vitest';
import { extractParameterLabels } from '../../src/runtime/parse-param-labels';

describe('extractParameterLabels', () => {
  it('extracts THETA labels one-per-line (Pirana style)', () => {
    const out = extractParameterLabels(`$THETA
  1 ; A
  1 ; B
  1 ; C
  1 ; D
`);
    expect([...out.thetas.entries()]).toEqual([
      [1, 'A'],
      [2, 'B'],
      [3, 'C'],
      [4, 'D'],
    ]);
  });

  it('attaches THETA label to last value when multiple-per-line', () => {
    const out = extractParameterLabels(`$THETA 1 2 3 ; X
`);
    // Three values; label binds to the last (index 3).
    expect(out.thetas.get(3)).toBe('X');
    expect(out.thetas.has(1)).toBe(false);
    expect(out.thetas.has(2)).toBe(false);
  });

  it('extracts OMEGA BLOCK(N) labels — label attaches to the diagonal of each row', () => {
    const out = extractParameterLabels(`$OMEGA BLOCK(4)
  0.1 ; A
  0.05 0.1 ; B
  0.05 0.05 0.1 ; C
  0.05 0.05 0.05 0.1 ; D
`);
    expect([...out.omegas.entries()]).toEqual([
      [1, 'A'],
      [2, 'B'],
      [3, 'C'],
      [4, 'D'],
    ]);
  });

  it('extracts diagonal-form OMEGA labels — each row is one variance', () => {
    const out = extractParameterLabels(`$OMEGA
  0.1 ; CL
  0.2 ; V
`);
    expect(out.omegas.get(1)).toBe('CL');
    expect(out.omegas.get(2)).toBe('V');
  });

  it('handles inline record header — $OMEGA 0.1 ; A on a single line', () => {
    const out = extractParameterLabels(`$OMEGA 0.1 ; A
`);
    expect(out.omegas.get(1)).toBe('A');
  });

  it('handles inline BLOCK header — $OMEGA BLOCK(2) 0.1 0.05 0.1 ; M', () => {
    const out = extractParameterLabels(`$OMEGA BLOCK(2) 0.1 0.05 0.1 ; M
`);
    // The header line is row 1 of the block; label binds to (1,1).
    expect(out.omegas.get(1)).toBe('M');
  });

  it('continues OMEGA index across multiple $OMEGA records', () => {
    const out = extractParameterLabels(`$OMEGA BLOCK(2)
  0.1 ; A
  0.05 0.1 ; B
$OMEGA
  0.3 ; C
`);
    expect(out.omegas.get(1)).toBe('A');
    expect(out.omegas.get(2)).toBe('B');
    expect(out.omegas.get(3)).toBe('C');
  });

  it('handles $SIGMA independently from $OMEGA counter', () => {
    const out = extractParameterLabels(`$OMEGA 0.1 ; A
$SIGMA 1 ; S1
`);
    expect(out.omegas.get(1)).toBe('A');
    expect(out.sigmas.get(1)).toBe('S1');
    expect(out.thetas.size).toBe(0);
  });

  it('ignores lines with no numeric values (pure-comment lines)', () => {
    const out = extractParameterLabels(`$THETA
; just a comment
  1 ; A
`);
    expect(out.thetas.get(1)).toBe('A');
    expect(out.thetas.size).toBe(1);
  });

  it('handles records with no labels — counter advances, map stays empty', () => {
    const out = extractParameterLabels(`$THETA
  1
  2
  3
`);
    expect(out.thetas.size).toBe(0);
  });

  it('stops collecting at the next record keyword', () => {
    const out = extractParameterLabels(`$THETA
  1 ; A
$PK
  ; not a parameter line
  CL = THETA(1)
`);
    expect(out.thetas.get(1)).toBe('A');
    expect(out.omegas.size).toBe(0);
    expect(out.sigmas.size).toBe(0);
  });

  it('accepts $THE / $OME / $SIG short forms', () => {
    const out = extractParameterLabels(`$THE 1 ; T1
$OME 0.1 ; O1
$SIG 1 ; S1
`);
    expect(out.thetas.get(1)).toBe('T1');
    expect(out.omegas.get(1)).toBe('O1');
    expect(out.sigmas.get(1)).toBe('S1');
  });

  it('returns empty maps for an empty / non-NMTRAN string', () => {
    const out = extractParameterLabels('');
    expect(out.thetas.size).toBe(0);
    expect(out.omegas.size).toBe(0);
    expect(out.sigmas.size).toBe(0);
  });
});
