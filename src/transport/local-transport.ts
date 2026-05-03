// Local transport: runs commands on the same host the extension host
// is running on. Used when Positron is in Remote SSH mode against the
// NONMEM host, so there's no need for an extra ssh hop.
//
// We deliberately do NOT scrub hostnames in this transport. The extension
// is running on the same machine the command targets — the "secret"
// hostname is our own, and the user already typed it in the terminal that
// launched Positron. There's nothing to leak.
//
// Note for hooks: `spawn` is the safer alternative to `exec`. We invoke
// /bin/sh -c on POSIX so shell expansion / piping behaves the same as
// ssh's remote-shell semantics. On Windows we'd run cmd /c — but the
// realistic deployment for LocalTransport is Linux (Remote SSH onto the
// NONMEM host). We support Windows for completeness; LocalTransport on a
// Windows machine is a degenerate case that probably means the user
// misconfigured `positronNonmem.host.transport`.
import { spawn } from 'child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  RemoteFileNotFoundError,
  TransportError,
  type CommandResult,
  type RemoteDirEntry,
  type RemoteFileStat,
  type RemoteFileType,
  type Transport,
} from './types';

/** Expand a leading `~` or `~/` against os.homedir(). Bare `~user` is not handled. */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export class LocalTransportError extends TransportError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'LocalTransportError';
  }
}

function shellInvocation(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { file: '/bin/sh', args: ['-c', command] };
}

export class LocalTransport implements Transport {
  readonly kind = 'local' as const;

  async run(command: string): Promise<CommandResult> {
    const { file, args } = shellInvocation(command);
    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(file, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString('utf8');
      });
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString('utf8');
      });
      child.once('error', (err) => {
        reject(new LocalTransportError(`failed to spawn shell: ${err.message}`, err));
      });
      child.once('close', (code) => {
        resolve({ code, stdout, stderr });
      });
    });
  }

  async putFile(localPath: string, remotePath: string): Promise<void> {
    const dst = expandHome(remotePath);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(localPath, dst);
  }

  async getFile(remotePath: string, localPath: string): Promise<void> {
    const src = expandHome(remotePath);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.copyFile(src, localPath);
  }

  async writeFile(remotePath: string, content: string): Promise<void> {
    const dst = expandHome(remotePath);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.writeFile(dst, content, 'utf8');
  }

  async readFile(remotePath: string): Promise<string> {
    const src = expandHome(remotePath);
    try {
      return await fs.readFile(src, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new RemoteFileNotFoundError(remotePath);
      }
      throw e;
    }
  }

  async stat(remotePath: string): Promise<RemoteFileStat> {
    const target = expandHome(remotePath);
    let s;
    try {
      s = await fs.lstat(target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new RemoteFileNotFoundError(remotePath);
      }
      throw e;
    }
    return {
      type: localStatType(s),
      size: s.size,
      mtime: Math.floor(s.mtimeMs / 1000),
    };
  }

  async readDirectory(remotePath: string): Promise<RemoteDirEntry[]> {
    const target = expandHome(remotePath);
    let entries;
    try {
      entries = await fs.readdir(target, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new RemoteFileNotFoundError(remotePath);
      }
      throw e;
    }
    return entries.map((d) => ({
      name: d.name,
      type: localDirentType(d),
    }));
  }
}

function localStatType(s: { isDirectory: () => boolean; isSymbolicLink: () => boolean }): RemoteFileType {
  if (s.isSymbolicLink()) return 'symlink';
  if (s.isDirectory()) return 'directory';
  return 'file';
}

function localDirentType(d: { isDirectory: () => boolean; isSymbolicLink: () => boolean }): RemoteFileType {
  if (d.isSymbolicLink()) return 'symlink';
  if (d.isDirectory()) return 'directory';
  return 'file';
}
