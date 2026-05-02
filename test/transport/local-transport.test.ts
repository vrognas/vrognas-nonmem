import { describe, it, expect } from 'vitest';
import { LocalTransport } from '../../src/transport/local-transport';

// LocalTransport spawns a real child process. We use only commands that
// behave the same on cmd.exe and /bin/sh — `echo` and `exit` — so the
// tests run identically on Windows (CI) and Linux (Remote SSH targets).
// Anything fancier (Node embedded scripts, HEREDOCs) chokes on cmd's
// quote handling.

const isWin = process.platform === 'win32';

describe('LocalTransport', () => {
  it('exposes kind === "local" for log-prefix selection', () => {
    expect(new LocalTransport().kind).toBe('local');
  });

  it('runs a command and captures stdout', async () => {
    const t = new LocalTransport();
    const result = await t.run('echo hello-from-local');
    expect(result.code).toBe(0);
    // Trim because `echo` on Windows appends \r\n, on POSIX \n.
    expect(result.stdout.trim()).toBe('hello-from-local');
  });

  it('captures non-zero exit codes', async () => {
    const t = new LocalTransport();
    // `exit /b N` for cmd, `exit N` for sh.
    const cmd = isWin ? 'exit /b 7' : 'exit 7';
    const result = await t.run(cmd);
    expect(result.code).toBe(7);
  });

  it('separates stderr from stdout (POSIX-only)', async () => {
    if (isWin) return; // cmd's stderr-redirection syntax is too painful
    const t = new LocalTransport();
    const result = await t.run('echo to-stdout; echo to-stderr 1>&2');
    expect(result.stdout).toContain('to-stdout');
    expect(result.stderr).toContain('to-stderr');
  });
});
