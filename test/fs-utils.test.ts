import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { findSiblingByExt, pathExists } from '../src/fs-utils';

async function workdir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

describe('findSiblingByExt', () => {
  it('returns the exact-case match when one exists', async () => {
    const dir = await workdir('fs-exact');
    const target = path.join(dir, 'run001.mod');
    await fs.writeFile(target, '');
    expect(await findSiblingByExt(dir, 'run001', ['.mod', '.ctl'])).toBe(target);
  });

  it('honors the extension precedence order (`.mod` before `.ctl`)', async () => {
    const dir = await workdir('fs-order');
    await fs.writeFile(path.join(dir, 'run001.mod'), 'mod');
    await fs.writeFile(path.join(dir, 'run001.ctl'), 'ctl');
    const out = await findSiblingByExt(dir, 'run001', ['.mod', '.ctl']);
    expect(out).toBe(path.join(dir, 'run001.mod'));
  });

  it('finds the file regardless of stem/extension case (case-insensitive scan or NTFS coalesce)', async () => {
    // On Linux/macOS (case-sensitive FS) the exact-case probe misses
    // and the readdir scan finds `Run001.MOD`. On Windows NTFS (case-
    // insensitive) the exact probe with `run001.mod` already succeeds.
    // Either way `findSiblingByExt` must return a path that resolves
    // to a real file.
    const dir = await workdir('fs-case');
    await fs.writeFile(path.join(dir, 'Run001.MOD'), '');
    const out = await findSiblingByExt(dir, 'run001', ['.mod']);
    expect(out).not.toBeNull();
    expect(await pathExists(out!)).toBe(true);
  });

  it('returns null when no candidate matches', async () => {
    const dir = await workdir('fs-none');
    await fs.writeFile(path.join(dir, 'other.txt'), '');
    expect(await findSiblingByExt(dir, 'run001', ['.mod', '.ctl'])).toBeNull();
  });

  it('returns null when the directory is unreadable / missing', async () => {
    expect(await findSiblingByExt('/no/such/path/anywhere', 'run001', ['.mod'])).toBeNull();
  });
});

describe('pathExists', () => {
  it('true for an existing file, false otherwise', async () => {
    const dir = await workdir('fs-exists');
    const f = path.join(dir, 'a.txt');
    await fs.writeFile(f, '');
    expect(await pathExists(f)).toBe(true);
    expect(await pathExists(path.join(dir, 'nope'))).toBe(false);
  });
});
