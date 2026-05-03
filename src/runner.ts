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

export class LocalRunner implements Runner {
  async run(command: string, cwd?: string): Promise<CommandResult> {
    const { file, args } = shellInvocation(command);
    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(file, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        cwd,
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
        reject(new RunnerError(`failed to spawn shell: ${err.message}`, err));
      });
      child.once('close', (code) => {
        resolve({ code, stdout, stderr });
      });
    });
  }
}
