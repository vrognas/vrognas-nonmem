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
import { promisify } from 'util';
import { execFile as execFileCb } from 'child_process';
import { TransportError, type CommandResult, type Transport } from './types';

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

export class SshTransport implements Transport {
  readonly kind = 'ssh' as const;

  constructor(private readonly alias: string) {}

  async run(command: string): Promise<CommandResult> {
    const resolved = await resolveAlias(this.alias);
    if (resolved.unmatched) {
      throw new SshTransportError(
        `no Host block matched alias "${this.alias}" in ~/.ssh/config — ssh -G echoed it as the hostname. Add a Host entry or change positronNonmem.host.alias.`,
      );
    }

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
    const resolved = await resolveAlias(this.alias);
    if (resolved.unmatched) {
      throw new SshTransportError(
        `no Host block matched alias "${this.alias}" in ~/.ssh/config — ssh -G echoed it as the hostname.`,
      );
    }
    await runScp(buildScpPutArgs(this.alias, localPath, remotePath), resolved.hostname);
  }

  async getFile(remotePath: string, localPath: string): Promise<void> {
    const resolved = await resolveAlias(this.alias);
    if (resolved.unmatched) {
      throw new SshTransportError(
        `no Host block matched alias "${this.alias}" in ~/.ssh/config — ssh -G echoed it as the hostname.`,
      );
    }
    await runScp(buildScpGetArgs(this.alias, remotePath, localPath), resolved.hostname);
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

// Exported for unit tests; not part of the runtime API.
export const __testing = { scrubHostname, buildScpPutArgs, buildScpGetArgs };
