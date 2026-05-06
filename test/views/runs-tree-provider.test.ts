import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import { RunsTreeProvider, type RunNode } from '../../src/views/runs-tree-provider';
import type { RunDir } from '../../src/views/runs-discovery';

function makeProvider(runs: RunDir[]): RunsTreeProvider {
  return new RunsTreeProvider(async () => runs);
}

function fixture(overrides: Partial<RunDir> = {}): RunDir {
  return {
    dirPath: '/runs/r1',
    relativePath: 'r1',
    mtime: 1000,
    primaryLst: 'm.lst',
    lstFiles: ['m.lst'],
    ...overrides,
  };
}

describe('RunsTreeProvider', () => {
  it('flat siblings render as one tree node each at top level', async () => {
    const provider = makeProvider([
      fixture({ dirPath: '/runs/pn-2', relativePath: 'pn-2', mtime: 2000 }),
      fixture({ dirPath: '/runs/pn-1', relativePath: 'pn-1', mtime: 1000 }),
    ]);
    const nodes = await provider.getChildren();
    expect(nodes).toHaveLength(2);
    const labels = nodes.map((n) => provider.getTreeItem(n).label);
    expect(labels).toEqual(['pn-1', 'pn-2']); // alphabetical
  });

  it('a run leaf has a vscode.open command pointing at the primary .lst', async () => {
    const provider = makeProvider([fixture({ relativePath: 'pn-1', dirPath: '/runs/pn-1' })]);
    const top = await provider.getChildren();
    const item = provider.getTreeItem(top[0]);
    const cmd = (item as { command?: { command: string; arguments: unknown[] } }).command;
    expect(cmd?.command).toBe('vscode.open');
    const uri = cmd?.arguments?.[0] as vscode.Uri;
    expect(uri.scheme).toBe('file');
    expect(uri.path).toBe('/runs/pn-1/m.lst');
  });

  it('shared ancestors collapse: parent renders as a folder, children expand', async () => {
    const provider = makeProvider([
      fixture({
        dirPath: '/work/proj/slow/modelfit_dir1',
        relativePath: 'proj/slow/modelfit_dir1',
      }),
      fixture({
        dirPath: '/work/proj/slow/modelfit_dir2',
        relativePath: 'proj/slow/modelfit_dir2',
      }),
    ]);
    const top = await provider.getChildren();
    expect(top).toHaveLength(1);
    expect(provider.getTreeItem(top[0]).label).toBe('proj');

    // Expand `proj` → one child `slow`
    const proj = (await provider.getChildren(top[0])) as RunNode[];
    expect(proj).toHaveLength(1);
    expect(provider.getTreeItem(proj[0]).label).toBe('slow');

    // Expand `slow` → two children, the actual run dirs
    const slow = (await provider.getChildren(proj[0])) as RunNode[];
    expect(slow.map((n) => provider.getTreeItem(n).label)).toEqual([
      'modelfit_dir1',
      'modelfit_dir2',
    ]);
  });

  it('a position can be both a run AND a parent of runs (hybrid node)', async () => {
    const provider = makeProvider([
      fixture({ dirPath: '/work/slow', relativePath: 'slow', primaryLst: 'run001.lst' }),
      fixture({
        dirPath: '/work/slow/modelfit_dir1',
        relativePath: 'slow/modelfit_dir1',
        primaryLst: 'run001.lst',
      }),
    ]);
    const top = await provider.getChildren();
    expect(top).toHaveLength(1);

    const slow = top[0];
    const item = provider.getTreeItem(slow);
    // Hybrid: has a command (clickable .lst) AND is collapsible.
    expect(
      (item as { command?: unknown }).command,
      'hybrid node should be clickable',
    ).toBeDefined();
    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);

    // Children: the modelfit_dir1 leaf
    const children = await provider.getChildren(slow);
    expect(children.map((c) => provider.getTreeItem(c).label)).toEqual(['modelfit_dir1']);
  });

  it('shows an info row when no runs are found', async () => {
    const provider = makeProvider([]);
    const nodes = await provider.getChildren();
    expect(nodes).toHaveLength(1);
    const item = provider.getTreeItem(nodes[0]);
    expect(item.label).toContain('No NONMEM runs');
  });

  it('caches the scan result; refresh() forces a re-scan', async () => {
    let calls = 0;
    const provider = new RunsTreeProvider(async () => {
      calls++;
      return [fixture()];
    });

    await provider.getChildren();
    await provider.getChildren();
    expect(calls).toBe(1);

    provider.refresh();
    await provider.getChildren();
    expect(calls).toBe(2);
  });

  it('a leaf run node has no children', async () => {
    const provider = makeProvider([fixture()]);
    const root = await provider.getChildren();
    expect(await provider.getChildren(root[0])).toEqual([]);
  });

  it('surfaces discovery errors as a single tree row', async () => {
    const provider = new RunsTreeProvider(async () => {
      throw new Error('scan failed');
    });
    const nodes = await provider.getChildren();
    const item = provider.getTreeItem(nodes[0]);
    expect(item.label).toContain('Error');
    expect(item.label).toContain('scan failed');
  });
});
