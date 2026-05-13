import { describe, it, expect } from 'vitest';
import { parseTableBlocks } from '../../src/runtime/parse-table-blocks';

describe('parseTableBlocks', () => {
  it('returns one block per TABLE NO. header with method, header, and rows', () => {
    const text =
      'TABLE NO.  1: First Order Conditional Estimation: Problem=1\n' +
      ' ITERATION    THETA1       OBJ\n' +
      '          0   1.0000E+00   100.0\n' +
      '          1   1.5000E+00   95.0\n' +
      'TABLE NO.  2: Importance Sampling: Problem=1\n' +
      ' ITERATION    THETA1       OBJ\n' +
      '          0   1.5000E+00   95.0\n';

    const blocks = parseTableBlocks(text, (l) => /^ITERATION\b/i.test(l));

    expect(blocks).toHaveLength(2);
    expect(blocks[0].method).toBe('First Order Conditional Estimation');
    expect(blocks[0].headerTokens).toEqual(['ITERATION', 'THETA1', 'OBJ']);
    expect(blocks[0].rowLines).toEqual(['0   1.0000E+00   100.0', '1   1.5000E+00   95.0']);
    expect(blocks[1].method).toBe('Importance Sampling');
    expect(blocks[1].headerTokens).toEqual(['ITERATION', 'THETA1', 'OBJ']);
    expect(blocks[1].rowLines).toEqual(['0   1.5000E+00   95.0']);
  });

  it('returns a block with null headerTokens when no header line matches', () => {
    // Truncated file: TABLE header but no ITERATION column row arrived.
    const text =
      'TABLE NO.  1: SAEM: Problem=1\n' +
      '          0   1.0000E+00   100.0\n';

    const blocks = parseTableBlocks(text, (l) => /^ITERATION\b/i.test(l));

    expect(blocks).toHaveLength(1);
    expect(blocks[0].headerTokens).toBeNull();
    // Without a header match, every non-empty post-TABLE line is a row.
    expect(blocks[0].rowLines).toEqual(['0   1.0000E+00   100.0']);
  });

  it('treats a re-occurring header-shaped line as a data row (first-match-wins)', () => {
    // parse-cnv documented behaviour: a stray `ITERATION` line inside
    // the block must NOT stomp the captured header.
    const text =
      'TABLE NO.  1: SAEM\n' +
      ' ITERATION    THETA1       SAEMOBJ\n' +
      ' -2000000000  1.0000E+00   100.0\n' +
      ' ITERATION    THETA1       SAEMOBJ\n' + // stray reoccurrence
      ' -2000000001  1.0000E-02   2.0\n';

    const blocks = parseTableBlocks(text, (l) => /^ITERATION\b/i.test(l));

    expect(blocks).toHaveLength(1);
    expect(blocks[0].headerTokens).toEqual(['ITERATION', 'THETA1', 'SAEMOBJ']);
    expect(blocks[0].rowLines).toHaveLength(3);
    expect(blocks[0].rowLines[1]).toMatch(/^ITERATION/);
  });

  it('returns empty array on input without a TABLE NO. header', () => {
    expect(parseTableBlocks('', (l) => /ITERATION/.test(l))).toEqual([]);
    expect(parseTableBlocks('just some\nnoise lines\n', (l) => /ITERATION/.test(l))).toEqual([]);
  });
});
