import { describe, it, expect } from 'vitest';
import { parseLstEstRecords } from '../../src/runtime/parse-lst-est-records';

describe('parseLstEstRecords', () => {
  it('extracts a single $ESTIMATION record with whitespace-separated tokens', () => {
    const stream = `$PROBLEM example
$INPUT ID TIME DV
$DATA d.csv IGNORE=@
$ESTIMATION METHOD=COND MAXEVAL=99 PRINT=10`;
    const records = parseLstEstRecords(stream);
    expect(records).toHaveLength(1);
    expect(records[0].keyword).toBe('$ESTIMATION');
    expect(records[0].tokens).toEqual(['METHOD=COND', 'MAXEVAL=99', 'PRINT=10']);
    expect(records[0].index).toBe(0);
  });

  it('handles all $EST keyword aliases ($EST, $ESTM, $ESTIMATE, $ESTIMATION)', () => {
    const stream = `$PROBLEM
$EST METHOD=COND
$ESTIMATION METHOD=SAEM NITER=10
$ESTIMATE METHOD=IMP
$ESTM METHOD=ITS`;
    const records = parseLstEstRecords(stream);
    expect(records).toHaveLength(4);
    expect(records.map((r) => r.keyword)).toEqual([
      '$EST',
      '$ESTIMATION',
      '$ESTIMATE',
      '$ESTM',
    ]);
  });

  it('joins continuation lines into a single record body', () => {
    // NMTRAN: a $EST record extends across all subsequent non-$RECORD lines.
    // The user might break a long $EST onto multiple lines for readability.
    const stream = `$PROBLEM
$ESTIMATION METHOD=SAEM AUTO=1
   NITER=1000 NBURN=4000
   ISAMPLE=2 CTYPE=3
$COVARIANCE`;
    const records = parseLstEstRecords(stream);
    expect(records).toHaveLength(1);
    expect(records[0].tokens).toEqual([
      'METHOD=SAEM', 'AUTO=1', 'NITER=1000', 'NBURN=4000', 'ISAMPLE=2', 'CTYPE=3',
    ]);
  });

  it('strips end-of-line `;` comments', () => {
    const stream = `$PROBLEM
$ESTIMATION METHOD=COND ; comment about method
   PRINT=10 ;every 10 iters
   NOABORT`;
    const records = parseLstEstRecords(stream);
    expect(records[0].tokens).toEqual(['METHOD=COND', 'PRINT=10', 'NOABORT']);
  });

  it('NOABORT vs NOHABORT preserved as distinct tokens (the canonical use case)', () => {
    // XML conflates both into abort='no'. The .lst echo is the only
    // surface that distinguishes them — load-bearing.
    const noabort = parseLstEstRecords(`$PROBLEM
$ESTIMATION METHOD=COND NOABORT MAXEVAL=99`);
    const nohabort = parseLstEstRecords(`$PROBLEM
$ESTIMATION METHOD=COND NOHABORT MAXEVAL=99`);
    expect(noabort[0].tokens).toContain('NOABORT');
    expect(noabort[0].tokens).not.toContain('NOHABORT');
    expect(nohabort[0].tokens).toContain('NOHABORT');
    expect(nohabort[0].tokens).not.toContain('NOABORT');
  });

  it('chained $EST records preserve order via index field', () => {
    const stream = `$PROBLEM
$ESTIMATION METHOD=SAEM AUTO=1
$ESTIMATION METHOD=IMP EONLY=1 ISAMPLE=300
$COVARIANCE`;
    const records = parseLstEstRecords(stream);
    expect(records).toHaveLength(2);
    expect(records[0].index).toBe(0);
    expect(records[0].tokens).toContain('METHOD=SAEM');
    expect(records[1].index).toBe(1);
    expect(records[1].tokens).toContain('METHOD=IMP');
  });

  it('comma-separated tokens are split (NMTRAN allows comma OR whitespace)', () => {
    const stream = `$PROBLEM
$ESTIMATION METHOD=COND,MAXEVAL=99,PRINT=10`;
    const records = parseLstEstRecords(stream);
    expect(records[0].tokens).toEqual(['METHOD=COND', 'MAXEVAL=99', 'PRINT=10']);
  });

  it('normalises whitespace around the `=` sign in KEY=VALUE tokens', () => {
    // Modeller might write `MAXEVAL = 99` or `PRINT= 10`; canonicalise
    // so downstream key-equality checks work.
    const stream = `$PROBLEM
$ESTIMATION METHOD = COND MAXEVAL =99 PRINT= 10`;
    const records = parseLstEstRecords(stream);
    expect(records[0].tokens).toEqual(['METHOD=COND', 'MAXEVAL=99', 'PRINT=10']);
  });

  it('returns empty array for control streams with no $EST records', () => {
    const stream = `$PROBLEM
$INPUT ID TIME DV
$DATA d.csv IGNORE=@
$THETA 0.1`;
    expect(parseLstEstRecords(stream)).toEqual([]);
  });

  it('case-insensitive keyword matching', () => {
    const stream = `$problem
$estimation method=cond maxeval=99`;
    const records = parseLstEstRecords(stream);
    expect(records).toHaveLength(1);
    // The token case is the user's; we don't uppercase values.
    expect(records[0].tokens).toEqual(['method=cond', 'maxeval=99']);
  });

  it('handles record with NO body (bare `$ESTIMATION` with all defaults)', () => {
    const stream = `$PROBLEM
$ESTIMATION
$COVARIANCE`;
    const records = parseLstEstRecords(stream);
    expect(records).toHaveLength(1);
    expect(records[0].tokens).toEqual([]);
  });
});
