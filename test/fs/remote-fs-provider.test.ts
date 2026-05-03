import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import {
  REMOTE_FS_SCHEME,
  RemoteFileSystemProvider,
} from '../../src/fs/remote-fs-provider';
import {
  RemoteFileNotFoundError,
  type RemoteDirEntry,
  type RemoteFileStat,
  type Transport,
} from '../../src/transport/types';

class StubTransport implements Transport {
  readonly kind = 'local' as const;
  files = new Map<string, RemoteFileStat & { content?: string }>();
  dirs = new Map<string, RemoteDirEntry[]>();

  async run(): Promise<{ code: number; stdout: string; stderr: string }> {
    return { code: 0, stdout: '', stderr: '' };
  }
  async putFile(): Promise<void> {}
  async getFile(): Promise<void> {}
  async writeFile(): Promise<void> {}
  async readFile(remotePath: string): Promise<string> {
    const f = this.files.get(remotePath);
    if (!f || f.content === undefined) throw new RemoteFileNotFoundError(remotePath);
    return f.content;
  }
  async stat(remotePath: string): Promise<RemoteFileStat> {
    const f = this.files.get(remotePath);
    if (!f) throw new RemoteFileNotFoundError(remotePath);
    return { type: f.type, size: f.size, mtime: f.mtime };
  }
  async readDirectory(remotePath: string): Promise<RemoteDirEntry[]> {
    const d = this.dirs.get(remotePath);
    if (!d) throw new RemoteFileNotFoundError(remotePath);
    return d;
  }
}

function makeProvider(t: Transport, alias = 'primary'): RemoteFileSystemProvider {
  return new RemoteFileSystemProvider(async () => t, alias);
}

describe('RemoteFileSystemProvider — URI translation', () => {
  it('buildUri preserves an absolute remote path', () => {
    const u = RemoteFileSystemProvider.buildUri('primary', '/tmp/foo');
    expect(u.scheme).toBe(REMOTE_FS_SCHEME);
    expect(u.authority).toBe('primary');
    expect(u.path).toBe('/tmp/foo');
  });

  it('buildUri leaves ~/ paths intact (with a leading slash inserted)', () => {
    const u = RemoteFileSystemProvider.buildUri('primary', '~/positron-nonmem/pn-1');
    expect(u.path).toBe('/~/positron-nonmem/pn-1');
  });
});

describe('RemoteFileSystemProvider — read ops', () => {
  it('stat translates remote stat into vscode.FileStat', async () => {
    const t = new StubTransport();
    t.files.set('~/positron-nonmem/pn-1/m.lst', {
      type: 'file',
      size: 42,
      mtime: 1683500000,
    });
    const p = makeProvider(t);

    const stat = await p.stat(RemoteFileSystemProvider.buildUri('primary', '~/positron-nonmem/pn-1/m.lst'));
    expect(stat.type).toBe(vscode.FileType.File);
    expect(stat.size).toBe(42);
    expect(stat.mtime).toBe(1683500000_000); // seconds → milliseconds
  });

  it('stat maps RemoteFileNotFoundError to vscode.FileSystemError.FileNotFound', async () => {
    const p = makeProvider(new StubTransport());
    await expect(
      p.stat(RemoteFileSystemProvider.buildUri('primary', '~/missing')),
    ).rejects.toMatchObject({ code: 'FileNotFound' });
  });

  it('readFile returns content as a Uint8Array', async () => {
    const t = new StubTransport();
    t.files.set('~/foo.txt', { type: 'file', size: 5, mtime: 0, content: 'hello' });
    const p = makeProvider(t);
    const bytes = await p.readFile(RemoteFileSystemProvider.buildUri('primary', '~/foo.txt'));
    expect(Buffer.from(bytes).toString('utf8')).toBe('hello');
  });

  it('readDirectory translates entries into [name, vscode.FileType] tuples', async () => {
    const t = new StubTransport();
    t.dirs.set('~/positron-nonmem/pn-1', [
      { name: 'm.lst', type: 'file' },
      { name: 'sub', type: 'directory' },
      { name: 'link', type: 'symlink' },
    ]);
    const p = makeProvider(t);
    const entries = await p.readDirectory(
      RemoteFileSystemProvider.buildUri('primary', '~/positron-nonmem/pn-1'),
    );
    expect(entries).toEqual([
      ['m.lst', vscode.FileType.File],
      ['sub', vscode.FileType.Directory],
      ['link', vscode.FileType.SymbolicLink],
    ]);
  });

  it('rejects URIs whose authority does not match the served alias', async () => {
    const p = makeProvider(new StubTransport(), 'primary');
    const wrong = RemoteFileSystemProvider.buildUri('other-alias', '~/foo');
    await expect(p.stat(wrong)).rejects.toMatchObject({ code: 'FileNotFound' });
  });

  it('treats URI path "/" as the home dir (~)', async () => {
    const t = new StubTransport();
    t.dirs.set('~', [{ name: 'positron-nonmem', type: 'directory' }]);
    const p = makeProvider(t);
    const entries = await p.readDirectory(RemoteFileSystemProvider.buildUri('primary', ''));
    expect(entries).toEqual([['positron-nonmem', vscode.FileType.Directory]]);
  });

  it('preserves leading / on absolute remote paths (regression: v0.0.21 stripped it -> relative -> resolved against $HOME)', async () => {
    const t = new StubTransport();
    // Mimic the user-facing failure: find emitted /home/<user>/positron-nonmem/pn-X/m.lst.
    const remoteAbs = '/home/viktor.rognas@qpharmetra.com/positron-nonmem/pn-1/m.lst';
    t.files.set(remoteAbs, { type: 'file', size: 7, mtime: 0, content: 'lstdata' });
    const p = makeProvider(t);

    const uri = RemoteFileSystemProvider.buildUri('primary', remoteAbs);
    expect(uri.path).toBe(remoteAbs); // built URI keeps the leading /

    const bytes = await p.readFile(uri);
    expect(Buffer.from(bytes).toString('utf8')).toBe('lstdata');
  });
});

describe('RemoteFileSystemProvider — write surface (read-only chunk A)', () => {
  it('writeFile / delete / rename / createDirectory throw NoPermissions', () => {
    const p = makeProvider(new StubTransport());
    expect(() => p.writeFile()).toThrow(/read-only|NoPermissions/);
    expect(() => p.delete()).toThrow(/read-only|NoPermissions/);
    expect(() => p.rename()).toThrow(/read-only|NoPermissions/);
    expect(() => p.createDirectory()).toThrow(/read-only|NoPermissions/);
  });
});
