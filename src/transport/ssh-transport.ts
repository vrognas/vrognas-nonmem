// SSH transport that defers entirely to the system `ssh` CLI and
// `~/.ssh/config`. The user's existing alias / HostName / User / Port /
// IdentityFile / ProxyJump / ControlMaster setup just works — we never
// duplicate or reimplement OpenSSH's resolution.
//
// Privacy: error messages from `ssh` (DNS failures, connection refused,
// auth errors) leak the resolved HostName. We resolve the HostName once
// via `ssh -G <alias>`, cache it, and scrub it from any propagated
// stderr/error before it can reach a log surface or toast.
//
// Note for hooks: `spawn` is the safer alternative to `exec`; we never
// pass user-controlled strings to a shell. The remote command IS shell-
// evaluated by the remote sshd, so callers must escape user input before
// composing commands.
import { spawn } from 'child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'util';
import { execFile as execFileCb } from 'child_process';
import {
  RemoteFileNotFoundError,
  TransportError,
  type CommandResult,
  type RemoteDirEntry,
  type RemoteFileStat,
  type RemoteFileType,
  type Transport,
} from './types';

const execFile = promisify(execFileCb);

export class SshTransportError extends TransportError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'SshTransportError';
  }
}

/**
 * Resolved info derived from `ssh -G <alias>`. Used for scrubbing and
 * for surfacing helpful "no such Host block" diagnostics.
 */
export interface ResolvedAlias {
  alias: string;
  /** The HostName ssh would actually dial. Equal to the alias when no Host block matched. */
  hostname: string;
  /** True if no `Host <alias>` block matched (ssh -G echoed the alias as hostname). */
  unmatched: boolean;
}

const aliasCache = new Map<string, ResolvedAlias>();

export async function resolveAlias(alias: string): Promise<ResolvedAlias> {
  const cached = aliasCache.get(alias);
  if (cached) return cached;

  let stdout: string;
  try {
    const result = await execFile('ssh', ['-G', alias], { windowsHide: true });
    stdout = result.stdout;
  } catch (e) {
    throw new SshTransportError(
      `ssh -G ${alias} failed: ${(e as Error).message}. Is the OpenSSH client installed and on PATH?`,
      e,
    );
  }
  const match = stdout.match(/^hostname (.+)$/m);
  const hostname = match ? match[1].trim() : alias;
  const resolved: ResolvedAlias = {
    alias,
    hostname,
    unmatched: hostname.toLowerCase() === alias.toLowerCase(),
  };
  aliasCache.set(alias, resolved);
  return resolved;
}

export function clearAliasCache(): void {
  aliasCache.clear();
}

/** Replace every occurrence of `secret` in `message` with `<host>`. */
export function scrubHostname(message: string, secret: string): string {
  if (!secret) return message;
  return message.split(secret).join('<host>');
}

// scp argv builders kept pure for unit testing; the spawn happens in
// putFile / getFile below. Both use BatchMode=yes for the same reason as
// `run()` — fail fast instead of prompting interactively.
export function buildScpPutArgs(alias: string, localPath: string, remotePath: string): string[] {
  return ['-o', 'BatchMode=yes', localPath, `${alias}:${remotePath}`];
}

export function buildScpGetArgs(alias: string, remotePath: string, localPath: string): string[] {
  return ['-o', 'BatchMode=yes', `${alias}:${remotePath}`, localPath];
}

/**
 * Quote a remote path for safe interpolation into a bash command. Leading
 * `~` / `~/` becomes `"$HOME"` / `"$HOME"/'…'` so the remote shell expands
 * the home dir; the rest stays single-quoted so weird chars don't escape
 * into shell syntax. (Plain single quotes around `~/…` would NOT expand —
 * that was the bug `cat > '~/positron-nonmem/…/manifest.json'` hit.)
 */
export function quoteRemotePath(p: string): string {
  const escapeSingle = (s: string): string => s.replace(/'/g, `'\\''`);
  if (p === '~') return '"$HOME"';
  if (p.startsWith('~/')) return `"$HOME"/'${escapeSingle(p.slice(2))}'`;
  return `'${escapeSingle(p)}'`;
}

export class SshTransport implements Transport {
  readonly kind = 'ssh' as const;

  constructor(private readonly alias: string) {}

  async run(command: string): Promise<CommandResult> {
    const resolved = await this.requireResolvedAlias();

    return new Promise<CommandResult>((resolve, reject) => {
      // BatchMode=yes prevents ssh from prompting for passwords or
      // unknown-host confirmation; either we have agent / key auth set up
      // or we fail fast with a clean stderr message.
      const child = spawn('ssh', ['-o', 'BatchMode=yes', this.alias, command], {
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
        reject(
          new SshTransportError(
            `failed to spawn ssh: ${err.message}. Is the OpenSSH client installed and on PATH?`,
            err,
          ),
        );
      });
      child.once('close', (code) => {
        if (code === 0) {
          resolve({ code, stdout, stderr });
          return;
        }
        const scrubbed = scrubHostname(
          stderr.trim() || stdout.trim() || '(no output)',
          resolved.hostname,
        );
        if (code === 255) {
          reject(new SshTransportError(`ssh transport failed: ${scrubbed}`));
          return;
        }
        resolve({ code, stdout, stderr: scrubHostname(stderr, resolved.hostname) });
      });
    });
  }

  async putFile(localPath: string, remotePath: string): Promise<void> {
    const resolved = await this.requireResolvedAlias();
    await runScp(buildScpPutArgs(this.alias, localPath, remotePath), resolved.hostname);
  }

  async getFile(remotePath: string, localPath: string): Promise<void> {
    const resolved = await this.requireResolvedAlias();
    // scp won't create missing local parent dirs; mkdir before invoking it
    // so callers don't have to. Mirrors LocalTransport.getFile semantics.
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await runScp(buildScpGetArgs(this.alias, remotePath, localPath), resolved.hostname);
  }

  async writeFile(remotePath: string, content: string): Promise<void> {
    const resolved = await this.requireResolvedAlias();
    // Path is quoted via quoteRemotePath; content arrives via stdin and
    // is written by `cat` verbatim, so no payload escaping needed.
    return new Promise<void>((resolve, reject) => {
      const child = spawn(
        'ssh',
        ['-o', 'BatchMode=yes', this.alias, `cat > ${quoteRemotePath(remotePath)}`],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );
      let stderr = '';
      // MUST drain stdout even though we don't use it. With VisualHostKey
      // yes (or other chatty config) the ssh client writes banner output
      // to stdout; if we don't read it the OS pipe buffer fills (~64KB
      // on Linux) and the child blocks forever waiting for someone to
      // consume it. run() drains both pipes for the same reason.
      child.stdout.on('data', () => {});
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString('utf8');
      });
      child.once('error', (err) => {
        reject(new SshTransportError(`failed to spawn ssh: ${err.message}`, err));
      });
      child.once('close', (code) => {
        if (code === 0) return resolve();
        const scrubbed = scrubHostname(lastLine(stderr) || '(no output)', resolved.hostname);
        reject(new SshTransportError(`ssh writeFile exited ${code}: ${scrubbed}`));
      });
      child.stdin.end(content, 'utf8');
    });
  }

  async readFile(remotePath: string): Promise<string> {
    const result = await this.run(`cat ${quoteRemotePath(remotePath)}`);
    if (result.code !== 0) {
      if (isNoSuchFile(result.stderr)) {
        throw new RemoteFileNotFoundError(remotePath);
      }
      throw new SshTransportError(
        `ssh readFile exited ${result.code}: ${lastLine(result.stderr) || '(no output)'}`,
      );
    }
    return result.stdout;
  }

  async stat(remotePath: string): Promise<RemoteFileStat> {
    // GNU stat — '%s|%Y|%F' = size|mtime|description ("regular file" / "directory" / "symbolic link" / …).
    // `-L`-style symlink follow is OFF (default `lstat`-equivalent) so symlinks
    // surface as their own type for consumers that care.
    const result = await this.run(`stat -c '%s|%Y|%F' ${quoteRemotePath(remotePath)}`);
    if (result.code !== 0) {
      if (isNoSuchFile(result.stderr)) {
        throw new RemoteFileNotFoundError(remotePath);
      }
      throw new SshTransportError(
        `ssh stat exited ${result.code}: ${lastLine(result.stderr) || '(no output)'}`,
      );
    }
    return parseStatLine(result.stdout, remotePath);
  }

  async readDirectory(remotePath: string): Promise<RemoteDirEntry[]> {
    // `find -maxdepth 1 -mindepth 1 -printf '%f\t%y\n'` — emits one line per
    // entry with name + GNU find type code (f=file, d=dir, l=symlink, …).
    // Cleaner to parse than `ls -p`: explicit types, no escaping ambiguity.
    const result = await this.run(
      `find ${quoteRemotePath(remotePath)} -maxdepth 1 -mindepth 1 -printf '%f\\t%y\\n'`,
    );
    if (result.code !== 0) {
      if (isNoSuchFile(result.stderr)) {
        throw new RemoteFileNotFoundError(remotePath);
      }
      throw new SshTransportError(
        `ssh readDirectory exited ${result.code}: ${lastLine(result.stderr) || '(no output)'}`,
      );
    }
    return parseFindOutput(result.stdout);
  }

  /**
   * Resolve the alias and reject with a helpful error if no Host block
   * matched. All three transport entry points (run / putFile / getFile)
   * share this precondition — the user can't fix any of them without an
   * ~/.ssh/config change.
   */
  private async requireResolvedAlias(): Promise<ResolvedAlias> {
    const resolved = await resolveAlias(this.alias);
    if (resolved.unmatched) {
      throw new SshTransportError(
        `no Host block matched alias "${this.alias}" in ~/.ssh/config — ssh -G echoed it as the hostname. Add a Host entry or change positronNonmem.host.alias.`,
      );
    }
    return resolved;
  }
}

function runScp(args: string[], hostnameForScrub: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('scp', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString('utf8');
    });
    child.once('error', (err) => {
      reject(
        new SshTransportError(
          `failed to spawn scp: ${err.message}. Is the OpenSSH client installed and on PATH?`,
          err,
        ),
      );
    });
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const scrubbed = scrubHostname(stderr.trim() || '(no output)', hostnameForScrub);
      reject(new SshTransportError(`scp exited ${code}: ${scrubbed}`));
    });
  });
}

/**
 * Last non-empty line of a multi-line string. Used to extract the actual
 * error from ssh stderr which may also contain `VisualHostKey yes`
 * fingerprint art and other banner noise.
 */
function lastLine(s: string): string {
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.at(-1) ?? '';
}

/**
 * Heuristic for "remote tool reported absent path". Matches the standard
 * GNU coreutils / find phrasing across stat / cat / find. Used by stat /
 * readFile / readDirectory to map shell errors to RemoteFileNotFoundError.
 */
export function isNoSuchFile(stderr: string): boolean {
  return /No such file or directory/i.test(stderr) || /cannot stat/i.test(stderr);
}

/** Parse the `%s|%Y|%F` line emitted by `stat -c`. */
export function parseStatLine(stdout: string, remotePath: string): RemoteFileStat {
  const trimmed = stdout.trim();
  const parts = trimmed.split('|');
  if (parts.length < 3) {
    throw new SshTransportError(
      `ssh stat: unexpected output for ${remotePath}: ${trimmed.slice(0, 80)}`,
    );
  }
  return {
    type: statTypeFromDescription(parts[2]),
    size: Number(parts[0]) || 0,
    mtime: Number(parts[1]) || 0,
  };
}

/** GNU stat's `%F` description → our RemoteFileType. Unrecognised types fall through to 'file'. */
function statTypeFromDescription(desc: string): RemoteFileType {
  if (desc === 'directory') return 'directory';
  if (desc === 'symbolic link') return 'symlink';
  return 'file';
}

/** Parse `find -printf '%f\t%y\n'` output into [{name,type}]. */
export function parseFindOutput(stdout: string): RemoteDirEntry[] {
  return stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const tab = line.lastIndexOf('\t');
      const name = tab >= 0 ? line.slice(0, tab) : line;
      const code = tab >= 0 ? line.slice(tab + 1) : 'f';
      return { name, type: findTypeFromCode(code) };
    });
}

function findTypeFromCode(code: string): RemoteFileType {
  if (code === 'd') return 'directory';
  if (code === 'l') return 'symlink';
  return 'file';
}

// Exported for unit tests; not part of the runtime API.
export const __testing = {
  scrubHostname,
  buildScpPutArgs,
  buildScpGetArgs,
  quoteRemotePath,
  lastLine,
  isNoSuchFile,
  parseStatLine,
  parseFindOutput,
};
