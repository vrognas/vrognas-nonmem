import { describe, it, expect } from 'vitest';
import { countEstimationRecords } from '../../src/runtime/count-estimation-records';

describe('countEstimationRecords', () => {
  it('counts a single $EST record', () => {
    expect(
      countEstimationRecords(
        '$PROBLEM foo\n$EST METHOD=COND INTER MAXEVAL=99999 NSIG=3\n$COV\n',
      ),
    ).toBe(1);
  });

  it('counts chained $EST + accepts the abbreviated and full keywords', () => {
    expect(
      countEstimationRecords(
        `$PROBLEM SAEM->IMP-EONLY refinement
$EST METHOD=SAEM NBURN=1000 NITER=200
$ESTIMATION METHOD=IMP EONLY=1 NITER=5 ISAMPLE=3000
$COV PRINT=E UNCONDITIONAL
`,
      ),
    ).toBe(2);
  });

  it('skips commented-out $EST lines (semicolon prefix)', () => {
    expect(
      countEstimationRecords(
        `$PROBLEM foo
;$EST METHOD=SAEM      ; whole line is a comment
$EST METHOD=COND INTER ; trailing comment is fine
`,
      ),
    ).toBe(1);
  });

  it('returns 0 for empty / pre-$EST drafts', () => {
    expect(countEstimationRecords('')).toBe(0);
    expect(countEstimationRecords('$PROBLEM scratch\n$INPUT ID DV\n')).toBe(0);
  });
});
