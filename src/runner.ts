// Runner — minimal shell-out abstraction. We always run on the same
// host as nmfe76 (either Positron is running directly on the NONMEM
// box, or it's running there via Positron Remote SSH), so we don't
// care about the SSH layer ourselves.
//
// Tests pass a stub Runner; production code passes LocalRunner.
import { spawn } from 'node:child_process';

export class RunnerError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RunnerError';
  }
}

export interface CommandResult {
  /** Exit code, or null if the process was killed before exit. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface Runner {
  /** Run `command` (shell-evaluated) with optional working directory. */
  run(command: string, cwd?: string): Promise<CommandResult>;
}

function shellInvocation(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { file: '/bin/sh', args: ['-c', command] };
}

/**
 * Per-stream output cap. NONMEM / PsN can emit hundreds of MB of
 * iteration traces; without a cap the extension host OOMs accumulating
 * a multi-MB string. 8 MB is generous for normal Console use (full
 * `sumo` output is ~50 KB; a typical .lst tail is ~200 KB).
 */
export const MAX_OUTPUT_CHARS = 8 * 1024 * 1024;

/**
 * Capped append buffer. Drops chunks silently past `maxChars`, appends
 * a trailer once at finalize so the user sees that truncation happened.
 * Char-based (not byte-exact) — adequate for the OOM-prevention role;
 * cap precision in the MB range is irrelevant.
 */
export function createCappedBuffer(maxChars: number): {
  append: (s: string) => void;
  finalize: () => string;
} {
  const chunks: string[] = [];
  let length = 0;
  let truncated = false;
  return {
    append(s: string): void {
      if (truncated) return;
      if (length + s.length > maxChars) {
        const remaining = maxChars - length;
        if (remaining > 0) chunks.push(s.slice(0, remaining));
        truncated = true;
        length = maxChars;
      } else {
        chunks.push(s);
        length += s.length;
      }
    },
    finalize(): string {
      return (
        chunks.join('') +
        (truncated ? `\n[output truncated at ${maxChars} chars]\n` : '')
      );
    },
  };
}

export class LocalRunner implements Runner {
  async run(command: string, cwd?: string): Promise<CommandResult> {
    const { file, args } = shellInvocation(command);
    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(file, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        cwd,
      });
      const stdout = createCappedBuffer(MAX_OUTPUT_CHARS);
      const stderr = createCappedBuffer(MAX_OUTPUT_CHARS);
      child.stdout.on('data', (data: Buffer) => stdout.append(data.toString('utf8')));
      child.stderr.on('data', (data: Buffer) => stderr.append(data.toString('utf8')));
      child.once('error', (err) => {
        reject(new RunnerError(`failed to spawn shell: ${err.message}`, err));
      });
      child.once('close', (code) => {
        resolve({ code, stdout: stdout.finalize(), stderr: stderr.finalize() });
      });
    });
  }
}
