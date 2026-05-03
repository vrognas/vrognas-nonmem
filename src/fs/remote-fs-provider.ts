// `positron-nonmem://<alias>/<remote-path>` FileSystemProvider.
//
// Translates VSCode FS reads/stats into Transport ops on demand so we
// can browse remote run outputs (m.lst, m.ext, manifest.json, …) without
// syncing them locally. Read-only for chunk A; write/delete come later
// when we want edit-in-place flows.
//
// URI shape:
//   positron-nonmem://<alias>/<path>
//
// Tilde-form (relative to remote $HOME): the URI path carries a synthetic
// leading slash before `~` that we strip on extract.
//   positron-nonmem://primary/~/positron-nonmem/pn-1/m.lst
//     -> remote path "~/positron-nonmem/pn-1/m.lst"
// Absolute form: the URI path IS the remote path. Keep the leading `/`,
// otherwise the remote shell would resolve a relative path against $HOME
// (the bug v0.0.21 had: discovered runs lived under `/home/.../...` which
// got stripped to `home/.../...` and never resolved).
//   positron-nonmem://primary/home/u/runs/r1/m.lst
//     -> remote path "/home/u/runs/r1/m.lst"
//
// Lazy transport — we don't want to run `ssh -G` at activation time, so
// the constructor takes a factory that resolves on first FS request.
import * as vscode from 'vscode';
import {
  RemoteFileNotFoundError,
  type RemoteFileType,
  type Transport,
} from '../transport/types';

export const REMOTE_FS_SCHEME = 'positron-nonmem';

export class RemoteFileSystemProvider implements vscode.FileSystemProvider {
  private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  private transportPromise: Promise<Transport> | null = null;

  constructor(
    private readonly transportFactory: () => Promise<Transport>,
    /** Alias the FS provider serves; URIs with a different authority throw FileNotFound. */
    private readonly alias: string,
  ) {}

  /**
   * Build a `positron-nonmem://<alias>/<path>` URI from a remote path.
   * Leading `/` of the URI path is reserved by RFC 3986; we always emit
   * one even for `~/...` paths so VSCode round-trips them cleanly.
   */
  static buildUri(alias: string, remotePath: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: REMOTE_FS_SCHEME,
      authority: alias,
      path: remotePath.startsWith('/') ? remotePath : `/${remotePath}`,
    });
  }

  watch(): vscode.Disposable {
    // No remote inotify yet. Tree provider does its own polling-style
    // refresh on a filewatcher higher up; FS provider doesn't need to.
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const remote = this.assertAndExtract(uri);
    try {
      const s = await (await this.getTransport()).stat(remote);
      return {
        type: vscodeFileType(s.type),
        ctime: 0,
        mtime: s.mtime * 1000,
        size: s.size,
      };
    } catch (e) {
      throw mapError(e, uri);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const remote = this.assertAndExtract(uri);
    try {
      const text = await (await this.getTransport()).readFile(remote);
      return Buffer.from(text, 'utf8');
    } catch (e) {
      throw mapError(e, uri);
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const remote = this.assertAndExtract(uri);
    try {
      const entries = await (await this.getTransport()).readDirectory(remote);
      return entries.map((e) => [e.name, vscodeFileType(e.type)] as [string, vscode.FileType]);
    } catch (e) {
      throw mapError(e, uri);
    }
  }

  // Read-only chunk: writes throw NoPermissions. The FS-provider contract
  // requires these methods even if we never use them, so we surface a
  // clear error rather than silently no-op.
  writeFile(): void {
    throw vscode.FileSystemError.NoPermissions('positron-nonmem:// is read-only (chunk A)');
  }
  delete(): void {
    throw vscode.FileSystemError.NoPermissions('positron-nonmem:// is read-only (chunk A)');
  }
  rename(): void {
    throw vscode.FileSystemError.NoPermissions('positron-nonmem:// is read-only (chunk A)');
  }
  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions('positron-nonmem:// is read-only (chunk A)');
  }

  private assertAndExtract(uri: vscode.Uri): string {
    if (uri.scheme !== REMOTE_FS_SCHEME || uri.authority !== this.alias) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    // Empty / root URI path means "the remote home dir".
    if (!uri.path || uri.path === '/') return '~';
    // Tilde-form: synthetic leading `/` before `~` — strip it so the
    // remote shell sees `~/...` and expands $HOME itself.
    if (uri.path.startsWith('/~')) return uri.path.slice(1);
    // Absolute form: keep the leading `/` intact (the URI path IS the
    // remote absolute path).
    return uri.path;
  }

  private getTransport(): Promise<Transport> {
    return (this.transportPromise ??= this.transportFactory());
  }
}

function vscodeFileType(t: RemoteFileType): vscode.FileType {
  if (t === 'directory') return vscode.FileType.Directory;
  if (t === 'symlink') return vscode.FileType.SymbolicLink;
  return vscode.FileType.File;
}

function mapError(e: unknown, uri: vscode.Uri): unknown {
  if (e instanceof RemoteFileNotFoundError) {
    return vscode.FileSystemError.FileNotFound(uri);
  }
  return e;
}
