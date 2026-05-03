import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import { RunsTreeProvider } from '../../src/views/runs-tree-provider';
import { REMOTE_FS_SCHEME } from '../../src/fs/remote-fs-provider';
import type {
  CommandResult,
  RemoteDirEntry,
  RemoteFileStat,
  Transport,
} from '../../src/transport/types';

class StubTransport implements Transport {
  readonly kind = 'local' as const;
  /** Canned output for the next run() call. */
  nextStdout = '';
  nextCode = 0;

  async run(_cmd: string): Promise<CommandResult> {
    return { code: this.nextCode, stdout: this.nextStdout, stderr: '' };
  }
  async putFile(): Promise<void> {}
  async getFile(): Promise<void> {}
  async writeFile(): Promise<void> {}
  async readFile(): Promise<string> {
    return '';
  }
  async stat(): Promise<RemoteFileStat> {
    throw new Error('not used');
  }
  async readDirectory(): Promise<RemoteDirEntry[]> {
    throw new Error('not used');
  }
}

function makeProvider(t: Transport, alias = 'primary', root = '~/positron-nonmem') {
  return new RunsTreeProvider(async () => t, alias, () => root);
}

describe('RunsTreeProvider', () => {
  it('emits one node per run-dir, with command targeting the primary .lst as positron-nonmem:// URI', async () => {
    const t = new StubTransport();
    t.nextStdout = [
      '~/positron-nonmem/pn-2\tm.lst\t2000',
      '~/positron-nonmem/pn-1\tm.lst\t1000',
    ].join('\n');
    const provider = makeProvider(t);

    const nodes = await provider.getChildren();
    expect(nodes).toHaveLength(2);

    const items = nodes.map((n) => provider.getTreeItem(n));
    // Sorted freshest-first: pn-2 before pn-1.
    expect(items[0].label).toBe('pn-2');
    expect(items[1].label).toBe('pn-1');

    const cmd = (items[0] as { command?: { command: string; arguments: unknown[] } }).command;
    expect(cmd?.command).toBe('vscode.open');
    const uri = cmd?.arguments?.[0] as vscode.Uri;
    expect(uri.scheme).toBe(REMOTE_FS_SCHEME);
    expect(uri.authority).toBe('primary');
    expect(uri.path).toBe('/~/positron-nonmem/pn-2/m.lst');
  });

  it('shows an info row when the root has no runs', async () => {
    const t = new StubTransport();
    t.nextStdout = '';
    const provider = makeProvider(t);
    const nodes = await provider.getChildren();
    expect(nodes).toHaveLength(1);
    const item = provider.getTreeItem(nodes[0]);
    expect(item.label).toContain('No runs found');
  });

  it('caches the scan result; refresh() forces a re-scan', async () => {
    const t = new StubTransport();
    t.nextStdout = '~/positron-nonmem/pn-1\tm.lst\t1';
    const provider = makeProvider(t);

    expect((await provider.getChildren()).length).toBe(1);

    // Change the canned output — should NOT be picked up without refresh.
    t.nextStdout = '~/positron-nonmem/pn-1\tm.lst\t1\n~/positron-nonmem/pn-2\tm.lst\t2';
    expect((await provider.getChildren()).length).toBe(1);

    provider.refresh();
    expect((await provider.getChildren()).length).toBe(2);
  });

  it('returns [] for child requests on a leaf (flat list — chunk B)', async () => {
    const provider = makeProvider(new StubTransport());
    const root = await provider.getChildren();
    expect(await provider.getChildren(root[0])).toEqual([]);
  });
});
