import { describe, it, expect } from 'vitest';
import { extractControlStream } from '../../src/runtime/extract-control-stream';

describe('extractControlStream', () => {
  it('slices from $PROBLEM up to "NM-TRAN MESSAGES" (most common terminator)', () => {
    const lst = [
      'Mon May  4 10:14:19 PM UTC 2026', // PsN execute prefix line
      '$PROBLEM Cubic',
      '$INPUT ID TIME DV',
      '$DATA d.csv IGNORE=@',
      '$THETA 1 ;CL',
      '$OMEGA 0.1',
      '$SIGMA 1',
      '$ESTIMATION METHOD=COND INTER',
      '',
      'NM-TRAN MESSAGES',
      '  WARNINGS AND ERRORS (IF ANY) FOR PROBLEM    1',
      '1NONLINEAR MIXED EFFECTS MODEL PROGRAM (NONMEM) VERSION 7.6.0',
    ].join('\n');
    const cs = extractControlStream(lst);
    expect(cs).not.toBeNull();
    expect(cs!).toContain('$PROBLEM Cubic');
    expect(cs!).toContain('$THETA 1 ;CL');
    expect(cs!).toContain('$ESTIMATION');
    expect(cs!).not.toContain('NM-TRAN MESSAGES');
    expect(cs!).not.toContain('1NONLINEAR');
  });

  it('falls through to "1NONLINEAR" terminator when "NM-TRAN MESSAGES" is absent', () => {
    const lst = [
      '$PROBLEM Test',
      '$INPUT ID',
      '$THETA 1',
      '1NONLINEAR MIXED EFFECTS MODEL PROGRAM',
    ].join('\n');
    const cs = extractControlStream(lst);
    expect(cs).toContain('$THETA 1');
    expect(cs).not.toContain('1NONLINEAR');
  });

  it('also accepts `$PROB` (short form) as the start marker', () => {
    const lst = '$PROB Short form\n$THETA 1\nNM-TRAN MESSAGES\n';
    expect(extractControlStream(lst)).toBe('$PROB Short form\n$THETA 1');
  });

  it('returns null when no $PROBLEM/$PROB line is present', () => {
    expect(extractControlStream('1NONLINEAR MIXED EFFECTS\nstuff\n')).toBeNull();
  });

  it('handles CRLF line endings (real Windows-saved .lst)', () => {
    const lst = '$PROBLEM crlf\r\n$THETA 1\r\nNM-TRAN MESSAGES\r\n';
    const cs = extractControlStream(lst);
    expect(cs).toContain('$PROBLEM crlf');
    expect(cs).toContain('$THETA 1');
  });

  it('returns null when no terminator is found within the cap (corrupted/truncated .lst)', () => {
    // No `NM-TRAN MESSAGES` / `1NONLINEAR` line ever appears → safer
    // to surface "no model" than to feed the parser an incomplete /
    // garbled control stream that would render misleading rows.
    const lst = '$PROBLEM Truncated\n$THETA 1\n$OMEGA 0.1\n';
    expect(extractControlStream(lst)).toBeNull();
  });

  it('caps the search at 2000 lines past $PROBLEM (defends against pathological .lst)', () => {
    const head = ['$PROBLEM Stress', '$THETA 1'];
    const filler = Array.from({ length: 2200 }, (_, i) => `noise ${i}`);
    // Terminator past the cap — must NOT be reached.
    const tail = ['NM-TRAN MESSAGES'];
    const lst = [...head, ...filler, ...tail].join('\n');
    expect(extractControlStream(lst)).toBeNull();
  });
});
