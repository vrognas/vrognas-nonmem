import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runModel,
  parseDataFilename,
  parseOfv,
  type RunModelOptions,
} from '../../src/runtime/run-model';
import type { CommandResult, Runner } from '../../src/runner';

class FakeRunner implements Runner {
  readonly runs: { command: string; cwd: string | undefined }[] = [];
  /** Per-call canned results. Defaults to EXIT=0 stdout. */
  readonly results: CommandResult[] = [];

  async run(command: string, cwd?: string): Promise<CommandResult> {
    this.runs.push({ command, cwd });
    return this.results.shift() ?? { code: 0, stdout: 'EXIT=0\n', stderr: '' };
  }
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'run-model-'));
}

describe('parseDataFilename', () => {
  it('extracts bare filename', () => {
    expect(parseDataFilename('$DATA d\n')).toBe('d');
  });
  it('strips $DATA options like IGNORE=#', () => {
    expect(parseDataFilename('$DATA d IGNORE=#\n')).toBe('d');
  });
  it('handles relative subdir paths', () => {
    expect(parseDataFilename('$DATA ../shared/dataset.csv\n')).toBe('../shared/dataset.csv');
  });
  it('returns undefined when no $DATA record present', () => {
    expect(parseDataFilename('$PROBLEM only\n')).toBeUndefined();
  });
  it('matches case-insensitively (NONMEM accepts $data lowercase)', () => {
    expect(parseDataFilename('$data mydata.csv\n')).toBe('mydata.csv');
  });
  it('ignores $DATA appearing inside a comment column', () => {
    const text = '$PROBLEM ok\n; $DATA fake-comment\n$DATA real.csv\n';
    expect(parseDataFilename(text)).toBe('real.csv');
  });
});

describe('parseOfv', () => {
  it('extracts a scientific-notation value from a #OBJV banner line', () => {
    const lst =
      ' #OBJT:**             FINAL VALUE OF OBJECTIVE FUNCTION             *********\n' +
      ' #OBJV:************************    -2.05421E+01    ************************\n';
    expect(parseOfv(lst)).toBeCloseTo(-20.5421, 4);
  });
  it('extracts a plain decimal from a #OBJV banner line', () => {
    expect(parseOfv(' #OBJV:****    50.10342932195    ****\n')).toBeCloseTo(50.10342932195, 6);
  });
  it('returns the LAST #OBJV when multiple estimation steps emit one each', () => {
    const lst = ' #OBJV:****    100.0    ****\n some other lines\n #OBJV:****    42.5    ****\n';
    expect(parseOfv(lst)).toBeCloseTo(42.5, 4);
  });
  it('returns null when no #OBJV line is present', () => {
    expect(parseOfv('AN ERROR WAS FOUND IN THE CONTROL STATEMENTS.\n')).toBeNull();
  });
});

describe('runModel', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function makeOptions(
    overrides: { modelPath: string; runner: Runner } & Partial<RunModelOptions>,
  ): RunModelOptions {
    return {
      nmfeBinary: '/opt/nm760/run/nmfe76',
      ...overrides,
    };
  }

  it('runs nmfe76 in the .mod directory; output names follow the .mod basename', async () => {
    const modelPath = path.join(tmp, 'colistin.mod');
    fs.writeFileSync(modelPath, '$PROBLEM x\n$DATA d\n');
    fs.writeFileSync(path.join(tmp, 'colistin.lst'), ' #OBJV:****    -7.5    ****\n');
    const runner = new FakeRunner();

    const result = await runModel(makeOptions({ modelPath, runner }));

    expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0].cwd).toBe(tmp);
    expect(runner.runs[0].command).toContain(`'/opt/nm760/run/nmfe76' 'colistin.mod' 'colistin.lst'`);
    expect(runner.runs[0].command).toContain('echo EXIT=$?');

    expect(result.exitCode).toBe(0);
    expect(result.lstPath).toBe(path.join(tmp, 'colistin.lst'));
    expect(result.ofv).toBeCloseTo(-7.5, 4);
  });

  it('parses non-zero EXIT from stdout', async () => {
    const modelPath = path.join(tmp, 'm.mod');
    fs.writeFileSync(modelPath, '$PROBLEM x\n');
    const runner = new FakeRunner();
    runner.results.push({ code: 0, stdout: 'noise\nEXIT=42\n', stderr: '' });

    const result = await runModel(makeOptions({ modelPath, runner }));
    expect(result.exitCode).toBe(42);
  });

  it('tolerates missing .lst (NMTRAN-only failure) — ofv is null', async () => {
    const modelPath = path.join(tmp, 'm.mod');
    fs.writeFileSync(modelPath, '$PROBLEM x\n');
    // No m.lst file written.
    const runner = new FakeRunner();

    const result = await runModel(makeOptions({ modelPath, runner }));
    expect(result.ofv).toBeNull();
  });

  it('throws if .mod file does not exist', async () => {
    const runner = new FakeRunner();
    await expect(
      runModel(makeOptions({ modelPath: path.join(tmp, 'nope.mod'), runner })),
    ).rejects.toThrow(/model file not found/i);
    expect(runner.runs).toEqual([]);
  });

  it('shell-quotes paths so spaces / quotes in the .mod basename do not break the command', async () => {
    const modelPath = path.join(tmp, "o'brien.mod");
    fs.writeFileSync(modelPath, '$PROBLEM x\n');
    const runner = new FakeRunner();
    await runModel(makeOptions({ modelPath, runner }));
    // ' in the basename gets replaced by '\\'' (close-and-reopen idiom).
    expect(runner.runs[0].command).toContain(`'o'\\''brien.mod'`);
  });
});
