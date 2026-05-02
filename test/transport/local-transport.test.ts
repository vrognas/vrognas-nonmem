import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

describe('LocalTransport.putFile / getFile', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-transport-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('putFile copies a local file to a remote-style path (no remote actually exists)', async () => {
    const src = path.join(tmp, 'src.txt');
    const dst = path.join(tmp, 'dst.txt');
    fs.writeFileSync(src, 'hello');

    await new LocalTransport().putFile(src, dst);

    expect(fs.readFileSync(dst, 'utf8')).toBe('hello');
  });

  it('getFile copies a "remote" file back; creates missing parent dirs', async () => {
    const src = path.join(tmp, 'remote.txt');
    const dst = path.join(tmp, 'nested', 'subdir', 'local.txt');
    fs.writeFileSync(src, 'world');

    await new LocalTransport().getFile(src, dst);

    expect(fs.readFileSync(dst, 'utf8')).toBe('world');
  });

  it('expands a leading ~ to os.homedir() (so $HOME-rooted paths from the host pattern work)', async () => {
    // Use a unique filename under the user's actual home dir (we must clean up).
    const home = os.homedir();
    const uniq = `positron-nonmem-test-${Date.now()}-${process.pid}`;
    const remoteStyle = `~/${uniq}`;
    const realPath = path.join(home, uniq);
    const src = path.join(tmp, 'src.txt');
    fs.writeFileSync(src, 'tilde');

    try {
      await new LocalTransport().putFile(src, remoteStyle);
      expect(fs.readFileSync(realPath, 'utf8')).toBe('tilde');
    } finally {
      fs.rmSync(realPath, { force: true });
    }
  });
});
