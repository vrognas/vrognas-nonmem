import { describe, it, expect } from 'vitest';
import { buildRunsTree, type RunsTreeNode } from '../../src/views/runs-tree-builder';
import type { RunDir } from '../../src/views/runs-discovery';

function fix(relativePath: string, mtime = 0): RunDir {
  return {
    dirPath: '/abs/' + relativePath,
    relativePath,
    mtime,
    primaryLst: 'run001.lst',
    lstFiles: ['run001.lst'],
  };
}

/** Compact representation: '<label>(run?)[children...]' for assertion brevity. */
function shape(nodes: readonly RunsTreeNode[]): string {
  return nodes
    .map((n) => `${n.label}${n.run ? '*' : ''}${n.children.length ? `[${shape(n.children)}]` : ''}`)
    .join(',');
}

describe('buildRunsTree', () => {
  it('returns [] for an empty input', () => {
    expect(buildRunsTree([])).toEqual([]);
  });

  it('flat siblings → one tree per top-level segment', () => {
    expect(shape(buildRunsTree([fix('a'), fix('b'), fix('c')]))).toBe('a*,b*,c*');
  });

  it('shared ancestors collapse into a tree', () => {
    const tree = buildRunsTree([fix('proj/slow/modelfit_dir1'), fix('proj/slow/modelfit_dir2')]);
    expect(shape(tree)).toBe('proj[slow[modelfit_dir1*,modelfit_dir2*]]');
  });

  it('a position can be BOTH a run AND a parent of runs', () => {
    // `slow/` is a run dir with run001.lst AND has child modelfit_dirN/s.
    const tree = buildRunsTree([fix('proj/slow'), fix('proj/slow/modelfit_dir1')]);
    expect(shape(tree)).toBe('proj[slow*[modelfit_dir1*]]');
  });

  it('alphabetical sort at every level (case-insensitive)', () => {
    const tree = buildRunsTree([fix('Z'), fix('a/c'), fix('a/b'), fix('M')]);
    expect(shape(tree)).toBe('a[b*,c*],M*,Z*');
  });

  it('preserves the RunDir payload at each leaf', () => {
    const r1 = fix('proj/run1');
    const tree = buildRunsTree([r1]);
    expect(tree).toHaveLength(1);
    expect(tree[0].label).toBe('proj');
    expect(tree[0].children[0].label).toBe('run1');
    expect(tree[0].children[0].run).toBe(r1); // same identity, not a copy
  });

  it('handles a run living at the workspace root (empty relativePath)', () => {
    const r = fix('');
    const tree = buildRunsTree([r]);
    // Empty relativePath → synthetic root holds the run; nothing to enumerate at top level.
    expect(tree).toEqual([]);
  });

  it('handles backslash separators (Windows-style relativePaths)', () => {
    expect(shape(buildRunsTree([fix('a\\b\\c')]))).toBe('a[b[c*]]');
  });
});
