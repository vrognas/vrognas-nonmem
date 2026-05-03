import { describe, it, expect } from 'vitest';
import { groupLstHits } from '../../src/views/runs-discovery';

describe('groupLstHits', () => {
  it('groups multiple .lst files in the same dir into a single RunDir', () => {
    const runs = groupLstHits([
      { dirPath: '/runs/r1', fileName: 'm.lst', mtime: 1683500000 },
      { dirPath: '/runs/r1', fileName: 'run01.lst', mtime: 1683499900 },
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].dirPath).toBe('/runs/r1');
    expect(runs[0].lstFiles).toEqual(['m.lst', 'run01.lst']);
    expect(runs[0].mtime).toBe(1683500000); // most recent of the two
  });

  it('prefers m.lst as primary, otherwise alphabetically first', () => {
    const runs = groupLstHits([
      { dirPath: '/runs/our', fileName: 'm.lst', mtime: 1 },
      { dirPath: '/runs/our', fileName: 'x.lst', mtime: 1 },
      { dirPath: '/runs/pirana', fileName: 'run01.lst', mtime: 1 },
      { dirPath: '/runs/pirana', fileName: 'run02.lst', mtime: 1 },
    ]);
    const byPath = Object.fromEntries(runs.map((r) => [r.dirPath, r.primaryLst]));
    expect(byPath['/runs/our']).toBe('m.lst');
    expect(byPath['/runs/pirana']).toBe('run01.lst');
  });

  it('sorts results by mtime descending (freshest first)', () => {
    const runs = groupLstHits([
      { dirPath: '/r/old', fileName: 'm.lst', mtime: 1000 },
      { dirPath: '/r/mid', fileName: 'm.lst', mtime: 2000 },
      { dirPath: '/r/new', fileName: 'm.lst', mtime: 3000 },
    ]);
    expect(runs.map((r) => r.dirPath)).toEqual(['/r/new', '/r/mid', '/r/old']);
  });

  it('returns [] for empty input', () => {
    expect(groupLstHits([])).toEqual([]);
  });
});
