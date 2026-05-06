import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readPrderr } from '../../src/runtime/read-prderr';
import type { Runner } from '../../src/runner';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'prderr-'));
}

const PRDERR_TEXT = '0DURING SIMULATION STEP, PRED EXIT CODE = 1\n MORE DETAIL HERE\n';

describe('readPrderr', () => {
  it('reads `<modelfitDir>/NM_run1/PRDERR` when present (plain layout, e.g. -clean=3)', async () => {
    const modelfitDir = await tmpDir();
    await fs.mkdir(path.join(modelfitDir, 'NM_run1'));
    await fs.writeFile(path.join(modelfitDir, 'NM_run1', 'PRDERR'), PRDERR_TEXT);

    const result = await readPrderr({ modelfitDir });
    expect(result).toEqual({ content: PRDERR_TEXT, source: 'plain' });
  });

  it('extracts from `<modelfitDir>/NM_run1.7z` via runner when only the archive exists', async () => {
    const modelfitDir = await tmpDir();
    const archivePath = path.join(modelfitDir, 'NM_run1.7z');
    await fs.writeFile(archivePath, ''); // archive presence is what matters; runner stubs the contents

    const runner: Runner = {
      run: async (cmd, cwd) => {
        // Sanity: the command should target the archive and the PRDERR member.
        expect(cmd).toContain('7z');
        expect(cmd).toContain('PRDERR');
        expect(cmd).toContain(archivePath);
        // 7z prints `-so` content to stdout. We simulate that with an
        // arbitrary banner before the actual file content so the parser
        // has to handle 7z's chatty output realistically.
        void cwd;
        return {
          code: 0,
          stdout: PRDERR_TEXT,
          stderr: '',
        };
      },
    };

    const result = await readPrderr({ modelfitDir, runner });
    expect(result).toEqual({ content: PRDERR_TEXT, source: 'archive' });
  });

  it('returns null when archive exists but PRDERR is not in it (clean run, no warnings)', async () => {
    const modelfitDir = await tmpDir();
    await fs.writeFile(path.join(modelfitDir, 'NM_run1.7z'), '');
    const runner: Runner = {
      // 7z e with a missing member: RC != 0 OR empty stdout depending on version.
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
    };
    expect(await readPrderr({ modelfitDir, runner })).toBeNull();
  });

  it('returns null when neither plain PRDERR nor archive exists', async () => {
    const modelfitDir = await tmpDir();
    expect(await readPrderr({ modelfitDir })).toBeNull();
  });

  it('returns null when archive exists but no runner is provided (extraction unavailable)', async () => {
    const modelfitDir = await tmpDir();
    await fs.writeFile(path.join(modelfitDir, 'NM_run1.7z'), '');
    expect(await readPrderr({ modelfitDir })).toBeNull();
  });

  it('returns null when the runner reports 7z failure (binary missing / archive corrupt)', async () => {
    const modelfitDir = await tmpDir();
    await fs.writeFile(path.join(modelfitDir, 'NM_run1.7z'), '');
    const runner: Runner = {
      run: async () => ({ code: 127, stdout: '', stderr: '7z: command not found' }),
    };
    expect(await readPrderr({ modelfitDir, runner })).toBeNull();
  });
});
