import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import { RunsTreeProvider } from '../../src/views/runs-tree-provider';
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
  it('emits one node per RunDir; click target is the primary .lst as a file:// URI', async () => {
    const provider = makeProvider([
      fixture({ dirPath: '/runs/pn-2', relativePath: 'pn-2', mtime: 2000 }),
      fixture({ dirPath: '/runs/pn-1', relativePath: 'pn-1', mtime: 1000 }),
    ]);
    const nodes = await provider.getChildren();
    expect(nodes).toHaveLength(2);

    const items = nodes.map((n) => provider.getTreeItem(n));
    expect(items[0].label).toBe('pn-2');
    expect(items[1].label).toBe('pn-1');

    const cmd = (items[0] as { command?: { command: string; arguments: unknown[] } }).command;
    expect(cmd?.command).toBe('vscode.open');
    const uri = cmd?.arguments?.[0] as vscode.Uri;
    expect(uri.scheme).toBe('file');
    expect(uri.path).toBe('/runs/pn-2/m.lst');
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

  it('returns [] for child requests on a leaf (flat list)', async () => {
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
