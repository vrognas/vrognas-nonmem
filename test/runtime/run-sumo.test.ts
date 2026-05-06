import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runSumo } from '../../src/runtime/run-sumo';
import type { Runner } from '../../src/runner';

const SUMO_OUTPUT = `m.lst
No rounding errors                                                [    OK   ]
Objective function value: 4.5310
`;

describe('runSumo', () => {
  it('runs sumo in the .lst parent dir and returns the parsed summary on RC=0', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sumo-'));
    const lstPath = path.join(tmp, 'run001.lst');
    await fs.writeFile(lstPath, '');

    const runner: Runner = {
      run: async (cmd, cwd) => {
        expect(cwd).toBe(tmp);
        expect(cmd).toContain('sumo');
        expect(cmd).toContain('run001.lst');
        return { code: 0, stdout: SUMO_OUTPUT, stderr: '' };
      },
    };
    const result = await runSumo({ lstPath, runner });
    expect(result).not.toBeNull();
    expect(result!.ofv).toBeCloseTo(4.531, 3);
    expect(result!.statuses).toEqual([{ label: 'No rounding errors', level: 'OK', detail: [] }]);
  });

  it('returns null when sumo exits non-zero (stderr swallowed; caller decides what to log)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sumo-'));
    const lstPath = path.join(tmp, 'run001.lst');
    await fs.writeFile(lstPath, '');

    const runner: Runner = {
      run: async () => ({ code: 1, stdout: '', stderr: 'sumo: cannot read run001.lst' }),
    };
    expect(await runSumo({ lstPath, runner })).toBeNull();
  });

  it('returns null when sumo output is unparseable', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sumo-'));
    const lstPath = path.join(tmp, 'run001.lst');
    await fs.writeFile(lstPath, '');

    const runner: Runner = {
      run: async () => ({ code: 0, stdout: 'garbage output\n', stderr: '' }),
    };
    expect(await runSumo({ lstPath, runner })).toBeNull();
  });
});
