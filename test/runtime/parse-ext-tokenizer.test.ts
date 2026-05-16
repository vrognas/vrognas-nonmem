import { describe, it, expect } from 'vitest';
import { normalizeColumnName, parseExtBlocks } from '../../src/runtime/parse-ext-tokenizer';

describe('normalizeColumnName', () => {
  it('rewrites THETA1 → THETA(1)', () => {
    expect(normalizeColumnName('THETA1')).toBe('THETA(1)');
    expect(normalizeColumnName('THETA12')).toBe('THETA(12)');
  });

  it('case-insensitive', () => {
    expect(normalizeColumnName('theta3')).toBe('THETA(3)');
  });

  it('leaves OMEGA(i,j) / SIGMA(i,j) / OBJ unchanged', () => {
    expect(normalizeColumnName('OMEGA(1,1)')).toBe('OMEGA(1,1)');
    expect(normalizeColumnName('OMEGA(2,1)')).toBe('OMEGA(2,1)');
    expect(normalizeColumnName('SIGMA(1,1)')).toBe('SIGMA(1,1)');
    expect(normalizeColumnName('OBJ')).toBe('OBJ');
    expect(normalizeColumnName('SAEMOBJ')).toBe('SAEMOBJ');
  });
});

describe('parseExtBlocks', () => {
  it('returns empty for empty input', () => {
    expect(parseExtBlocks('')).toEqual([]);
  });

  it('extracts a single TABLE block with normalised header and rows', () => {
    const text = `TABLE NO.  1: First Order: Goal Function=MINIMUM VALUE OF OBJECTIVE FUNCTION ...
 ITERATION    THETA1    THETA2    OMEGA(1,1)    SIGMA(1,1)    OBJ
            0  1.00E+00  2.00E+00  1.00E-01      1.00E+00      1.79E+308
            1  1.10E+00  2.10E+00  1.05E-01      1.05E+00      500.0
   -1000000000  1.20E+00  2.20E+00  1.10E-01      1.10E+00      450.0
`;
    const blocks = parseExtBlocks(text);
    expect(blocks).toHaveLength(1);
    const b = blocks[0];
    expect(b.method).toContain('First Order');
    expect(b.header).toEqual(['THETA(1)', 'THETA(2)', 'OMEGA(1,1)', 'SIGMA(1,1)', 'OBJ']);
    expect(b.rows).toHaveLength(3);
    expect(b.rows[0].iter).toBe(0);
    expect(b.rows[0].tokens).toEqual(['1.00E+00', '2.00E+00', '1.00E-01', '1.00E+00', '1.79E+308']);
    expect(b.rows[2].iter).toBe(-1000000000);
  });

  it('multiple TABLE blocks (chained $EST) preserved in order', () => {
    const text = `TABLE NO.  1: First Order: ...
 ITERATION    THETA1    OBJ
            0  1.0E+00   100
   -1000000000  1.1E+00  90
TABLE NO.  2: Stochastic Approximation: ...
 ITERATION    THETA1    SAEMOBJ
            0  1.1E+00   90
   -1000000000  1.2E+00  85
`;
    const blocks = parseExtBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].method).toContain('First Order');
    expect(blocks[1].method).toContain('Stochastic Approximation');
    expect(blocks[0].header).toEqual(['THETA(1)', 'OBJ']);
    expect(blocks[1].header).toEqual(['THETA(1)', 'SAEMOBJ']);
  });

  it('block without ITERATION line returns header: null (truncated detection)', () => {
    const text = `TABLE NO.  1: ...\n`;
    const blocks = parseExtBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].header).toBeNull();
    expect(blocks[0].rows).toEqual([]);
  });

  it('blank lines and non-numeric leading tokens are skipped within a block', () => {
    const text = `TABLE NO.  1: Method
 ITERATION    THETA1    OBJ

            0  1.0E+00   100
 garbage line  not a number
            1  1.1E+00   90
`;
    const blocks = parseExtBlocks(text);
    expect(blocks[0].rows.map((r) => r.iter)).toEqual([0, 1]);
  });

  it('rows before any TABLE header are ignored (defensive against malformed .ext)', () => {
    const text = `   42  1.0  2.0\nTABLE NO.  1: M\n ITERATION THETA1 OBJ\n   0 1.0 100\n`;
    const blocks = parseExtBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].rows).toHaveLength(1);
    expect(blocks[0].rows[0].iter).toBe(0);
  });
});
