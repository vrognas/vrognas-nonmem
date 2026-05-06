import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { findExtFile } from '../../src/runtime/find-ext-file';

async function makeWorkdir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'find-ext-'));
}

describe('findExtFile', () => {
  it('prefers `<dir>/<basename>.ext` (Pirana / nmfe-direct layout)', async () => {
    const dir = await makeWorkdir();
    const lst = path.join(dir, 'run001.lst');
    const ext = path.join(dir, 'run001.ext');
    await fs.writeFile(lst, '');
    await fs.writeFile(ext, '');
    expect(await findExtFile(lst)).toBe(ext);
  });

  it('falls back to highest-N modelfit_dir<N>/<basename>.ext (PsN -nm_output layout)', async () => {
    const dir = await makeWorkdir();
    const lst = path.join(dir, 'run001.lst');
    await fs.writeFile(lst, '');
    // Two modelfit_dirs; pick the higher-N one (latest run).
    await fs.mkdir(path.join(dir, 'modelfit_dir1'));
    await fs.mkdir(path.join(dir, 'modelfit_dir2'));
    const stale = path.join(dir, 'modelfit_dir1', 'run001.ext');
    const fresh = path.join(dir, 'modelfit_dir2', 'run001.ext');
    await fs.writeFile(stale, 'OLD');
    await fs.writeFile(fresh, 'NEW');
    expect(await findExtFile(lst)).toBe(fresh);
  });

  it('returns null when neither layout has a matching .ext', async () => {
    const dir = await makeWorkdir();
    const lst = path.join(dir, 'run001.lst');
    await fs.writeFile(lst, '');
    expect(await findExtFile(lst)).toBeNull();
  });
});
