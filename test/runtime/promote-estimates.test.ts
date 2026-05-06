import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildUpdateInitsCommand,
  computeNextModelName,
  extractRunNumber,
  promoteEstimates,
} from '../../src/runtime/promote-estimates';
import type { Runner } from '../../src/runner';

describe('computeNextModelName', () => {
  // Build expectations through path.join so the test passes on both
  // POSIX and Windows runners (CI matrix safety).
  const join = (dir: string, base: string): string => path.join(dir, base);

  it('increments a zero-padded numeric suffix and preserves width + extension', () => {
    expect(computeNextModelName(join('/work', 'run001.mod'))).toBe(join('/work', 'run002.mod'));
    expect(computeNextModelName(join('/work', 'run099.ctl'))).toBe(join('/work', 'run100.ctl'));
    // 4-digit width preserved past the natural roll-over.
    expect(computeNextModelName(join('/work', 'run0099.mod'))).toBe(join('/work', 'run0100.mod'));
  });

  it("falls back to Pirana's '+1' convention when the stem has no trailing number", () => {
    expect(computeNextModelName(join('/work', 'm.mod'))).toBe(join('/work', 'm+1.mod'));
    // Already-promoted name keeps incrementing the trailing +N counter.
    expect(computeNextModelName(join('/work', 'm+1.mod'))).toBe(join('/work', 'm+2.mod'));
    expect(computeNextModelName(join('/work', 'm+9.mod'))).toBe(join('/work', 'm+10.mod'));
  });
});

describe('buildUpdateInitsCommand', () => {
  it('runs in the .mod parent dir and quotes both arguments', () => {
    const modelPath = path.join('/work', 'run001.mod');
    const { cmd, cwd } = buildUpdateInitsCommand(
      modelPath,
      path.join('/work', 'run002.mod'),
      'update_inits',
    );
    expect(cwd).toBe(path.dirname(modelPath));
    // Basename used as the positional arg (matches our `execute` invocation
    // pattern in run-model.ts) so PsN finds the sibling .lst.
    expect(cmd).toBe(`'update_inits' 'run001.mod' -output_model='run002.mod'`);
  });

  it('passes only the output basename to -output_model (PsN writes alongside the input)', () => {
    // If the caller passes a full path we still strip it — update_inits
    // writes the new file in the input model's directory regardless.
    const { cmd } = buildUpdateInitsCommand(
      path.join('/work', 'run001.mod'),
      path.join('/somewhere', 'else', 'run002.mod'),
      'update_inits',
    );
    expect(cmd).toContain(`-output_model='run002.mod'`);
    expect(cmd).not.toContain('somewhere');
  });
});

describe('promoteEstimates', () => {
  it('runs update_inits and returns the new model path on success', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promote-'));
    const inputModel = path.join(tmp, 'run001.mod');
    const outputModel = path.join(tmp, 'run002.mod');
    await fs.writeFile(inputModel, '$PROBLEM\n$THETA 1\n');

    const runner: Runner = {
      run: async (cmd, cwd) => {
        // Side-effect of update_inits: writes the new .mod next to the input.
        expect(cwd).toBe(tmp);
        expect(cmd).toContain('update_inits');
        await fs.writeFile(outputModel, '$PROBLEM\n$THETA 2.5\n');
        return { code: 0, stdout: 'Updating initial estimates\n', stderr: '' };
      },
    };

    const result = await promoteEstimates({
      modelPath: inputModel,
      outputName: 'run002.mod',
      runner,
    });

    expect(result.outputModelPath).toBe(outputModel);
    // File actually exists post-call.
    await expect(fs.access(outputModel)).resolves.toBeUndefined();
  });

  it('throws when update_inits exits non-zero, surfacing stdout+stderr', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promote-'));
    const inputModel = path.join(tmp, 'run001.mod');
    await fs.writeFile(inputModel, '$PROBLEM\n');

    const runner: Runner = {
      run: async () => ({
        code: 2,
        stdout: '',
        stderr: 'Cannot find run001.lst at /work/. died at update_inits line 42.',
      }),
    };

    await expect(
      promoteEstimates({ modelPath: inputModel, outputName: 'run002.mod', runner }),
    ).rejects.toThrow(/Cannot find run001\.lst/);
  });

  it('throws when update_inits exits 0 but produced no output file (defensive)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promote-'));
    const inputModel = path.join(tmp, 'run001.mod');
    await fs.writeFile(inputModel, '$PROBLEM\n');

    // RC=0 but no file created — shouldn't happen in practice but we want
    // a clean error rather than a confusing "open <missing>" downstream.
    const runner: Runner = {
      run: async () => ({ code: 0, stdout: 'Updating initial estimates\n', stderr: '' }),
    };

    await expect(
      promoteEstimates({ modelPath: inputModel, outputName: 'run002.mod', runner }),
    ).rejects.toThrow(/no output file produced/);
  });
});

describe('extractRunNumber', () => {
  it('extracts the integer from `run<NNN>` stems (with or without zero-pad)', () => {
    expect(extractRunNumber('/work/run001.mod')).toBe(1);
    expect(extractRunNumber('/work/run042.mod')).toBe(42);
    expect(extractRunNumber('/work/run100.ctl')).toBe(100);
  });

  it('returns null for non-runrecord-compatible names', () => {
    expect(extractRunNumber('/work/m.mod')).toBeNull();
    expect(extractRunNumber('/work/m+1.mod')).toBeNull();
    expect(extractRunNumber('/work/colistin.mod')).toBeNull();
    expect(extractRunNumber('/work/run001_alt.mod')).toBeNull();
  });

  it('rejects `run0` (PsN runrecord requires N ≥ 1, B4)', () => {
    // Without the fix, `run0.mod` returned 0, which `setBasedOn` would
    // happily write as `;; Based on: 0` — and PsN's runrecord tool
    // rejects it.
    expect(extractRunNumber('/work/run0.mod')).toBeNull();
    expect(extractRunNumber('/work/run00.mod')).toBeNull();
    expect(extractRunNumber('/work/run000.ctl')).toBeNull();
  });
});

describe('promoteEstimates — runrecord parent linkage', () => {
  // Helper: stub runner that simulates update_inits writing a fresh .mod.
  function stubRunnerWriting(outputPath: string, content: string): Runner {
    return {
      run: async () => {
        await fs.writeFile(outputPath, content);
        return { code: 0, stdout: 'Updating initial estimates\n', stderr: '' };
      },
    };
  }

  it('writes `;; Based on: N` directly under $PROBLEM in the new .mod', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promote-'));
    const inputModel = path.join(tmp, 'run001.mod');
    const outputModel = path.join(tmp, 'run002.mod');
    await fs.writeFile(inputModel, '$PROBLEM\n$THETA 1\n');

    const runner = stubRunnerWriting(outputModel, '$PROBLEM Cubic\n$INPUT ID\n$THETA 2.5\n');
    await promoteEstimates({ modelPath: inputModel, outputName: 'run002.mod', runner });

    const text = await fs.readFile(outputModel, 'utf8');
    expect(text).toContain('$PROBLEM Cubic\n;; Based on: 1\n$INPUT ID');
  });

  it('replaces an existing `;; Based on:` instead of duplicating it (idempotent re-promote)', async () => {
    // Simulate re-promoting from a model that already carries a parent
    // marker — the marker should rewrite to point at the new parent.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promote-'));
    const inputModel = path.join(tmp, 'run002.mod');
    const outputModel = path.join(tmp, 'run003.mod');
    await fs.writeFile(inputModel, '$PROBLEM\n$THETA 2.5\n');

    // update_inits will copy comments from the parent into the new .mod —
    // the stale `;; Based on: 1` must be rewritten to point at run002.
    const runner = stubRunnerWriting(
      outputModel,
      '$PROBLEM Cubic\n;; Based on: 1\n$INPUT ID\n$THETA 2.7\n',
    );
    await promoteEstimates({ modelPath: inputModel, outputName: 'run003.mod', runner });

    const text = await fs.readFile(outputModel, 'utf8');
    expect(text.match(/;; Based on:/g)?.length).toBe(1);
    expect(text).toContain(';; Based on: 2');
    expect(text).not.toContain(';; Based on: 1');
  });

  it('skips the marker when the parent basename is not run<NNN> (e.g. `m.mod`)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'promote-'));
    const inputModel = path.join(tmp, 'm.mod');
    const outputModel = path.join(tmp, 'm+1.mod');
    await fs.writeFile(inputModel, '$PROBLEM\n$THETA 1\n');

    const runner = stubRunnerWriting(outputModel, '$PROBLEM Cubic\n$INPUT ID\n$THETA 2.5\n');
    await promoteEstimates({ modelPath: inputModel, outputName: 'm+1.mod', runner });

    const text = await fs.readFile(outputModel, 'utf8');
    expect(text).not.toContain('Based on');
  });
});
