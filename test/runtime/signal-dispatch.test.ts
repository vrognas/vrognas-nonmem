import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { sendSignal } from '../../src/runtime/signal-dispatch';

async function makeTmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('sendSignal', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await makeTmpDir('positron-nonmem-sig-');
    await fs.mkdir(path.join(tmpRoot, 'NM_run1'), { recursive: true });
  });

  it('writes an empty file at <modelfitDir>/NM_run1/<name>', async () => {
    const r = await sendSignal({ modelfitDir: tmpRoot, name: 'next.sig' });
    expect(r.ok).toBe(true);
    expect(r.path).toBe(path.join(tmpRoot, 'NM_run1', 'next.sig'));
    const stat = await fs.stat(r.path);
    expect(stat.size).toBe(0);
  });

  it('returns ok=false with error message when NM_run1 does not exist yet', async () => {
    const earlyDir = await makeTmpDir('positron-nonmem-sig-early-');
    // No NM_run1 subdir created — simulates pre-nmfe-spawn window.
    const r = await sendSignal({ modelfitDir: earlyDir, name: 'stop.sig' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
  });

  it('overwrites an existing signal file (idempotent re-send)', async () => {
    // Existing stale file (e.g. left over from a prior aborted run).
    await fs.writeFile(path.join(tmpRoot, 'NM_run1', 'next.sig'), 'stale');
    const r = await sendSignal({ modelfitDir: tmpRoot, name: 'next.sig' });
    expect(r.ok).toBe(true);
    const content = await fs.readFile(r.path, 'utf8');
    expect(content).toBe('');
  });
});
