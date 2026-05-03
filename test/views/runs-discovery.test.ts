import { describe, it, expect } from 'vitest';
import { groupLstHits } from '../../src/views/runs-discovery';

describe('groupLstHits', () => {
  it('groups multiple .lst files in the same dir into a single RunDir', () => {
    const stdout = [
      '/home/u/runs/r1\tm.lst\t1683500000.0',
      '/home/u/runs/r1\trun01.lst\t1683499900.0',
    ].join('\n');
    const runs = groupLstHits(stdout, '/home/u/runs');
    expect(runs).toHaveLength(1);
    expect(runs[0].remotePath).toBe('/home/u/runs/r1');
    expect(runs[0].relativePath).toBe('r1');
    expect(runs[0].lstFiles).toEqual(['m.lst', 'run01.lst']);
    expect(runs[0].mtime).toBe(1683500000); // most recent of the two
  });

  it('prefers m.lst as primary, otherwise alphabetically first', () => {
    const stdout = [
      '/runs/our\tm.lst\t1\n/runs/our\tx.lst\t1',
      '/runs/pirana\trun01.lst\t1\n/runs/pirana\trun02.lst\t1',
    ].join('\n');
    const runs = groupLstHits(stdout, '/runs');
    const byPath = Object.fromEntries(runs.map((r) => [r.remotePath, r.primaryLst]));
    expect(byPath['/runs/our']).toBe('m.lst');
    expect(byPath['/runs/pirana']).toBe('run01.lst');
  });

  it('sorts results by mtime descending (freshest first)', () => {
    const stdout = [
      '/r/old\tm.lst\t1000.0',
      '/r/mid\tm.lst\t2000.0',
      '/r/new\tm.lst\t3000.0',
    ].join('\n');
    expect(groupLstHits(stdout, '/r').map((r) => r.relativePath)).toEqual(['new', 'mid', 'old']);
  });

  it('returns [] for empty find output (no runs under root)', () => {
    expect(groupLstHits('', '/r')).toEqual([]);
    expect(groupLstHits('\n\n', '/r')).toEqual([]);
  });

  it('falls back to the full remotePath when it does not start with root (defensive)', () => {
    const stdout = '/elsewhere/r1\tm.lst\t1';
    expect(groupLstHits(stdout, '/r').map((r) => r.relativePath)).toEqual(['/elsewhere/r1']);
  });

  it('skips malformed lines gracefully (missing fields, NaN mtime)', () => {
    const stdout = [
      'malformed-no-tabs',
      '/runs/ok\tm.lst\t1500',
      '/runs/bad\tm.lst\tnot-a-number',
    ].join('\n');
    const runs = groupLstHits(stdout, '/runs');
    const ok = runs.find((r) => r.relativePath === 'ok')!;
    expect(ok.mtime).toBe(1500);
    const bad = runs.find((r) => r.relativePath === 'bad')!;
    expect(bad.mtime).toBe(0); // NaN clamped to 0
  });
});
