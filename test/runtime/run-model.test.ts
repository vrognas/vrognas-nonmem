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
import { quote } from '../../src/shell';

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
      executeBinary: 'execute',
      ...overrides,
    };
  }

  it('runs `execute` in the .mod directory; PsN renames the lst itself so we pass only the .mod', async () => {
    const modelPath = path.join(tmp, 'colistin.mod');
    fs.writeFileSync(modelPath, '$PROBLEM x\n$DATA d\n');
    fs.writeFileSync(path.join(tmp, 'colistin.lst'), ' #OBJV:****    -7.5    ****\n');
    const runner = new FakeRunner();

    const result = await runModel(makeOptions({ modelPath, runner }));

    expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0].cwd).toBe(tmp);
    expect(runner.runs[0].command.startsWith(`${quote('execute')} `)).toBe(true);
    expect(runner.runs[0].command).toContain(quote('colistin.mod'));
    expect(runner.runs[0].command).not.toContain(quote('colistin.lst')); // PsN renames; we don't pass the lst arg
    expect(runner.runs[0].command).toContain('echo EXIT=$?');

    expect(result.exitCode).toBe(0);
    expect(result.lstPath).toBe(path.join(tmp, 'colistin.lst'));
    expect(result.ofv).toBeCloseTo(-7.5, 4);
  });

  it('throws when EXIT is non-zero even if .lst exists (e.g. EXIT=255)', async () => {
    const modelPath = path.join(tmp, 'm.mod');
    fs.writeFileSync(modelPath, '$PROBLEM x\n');
    fs.writeFileSync(path.join(tmp, 'm.lst'), ''); // .lst exists but exit signals failure
    const runner = new FakeRunner();
    runner.results.push({ code: 0, stdout: 'noise\nEXIT=255\n', stderr: '' });

    await expect(runModel(makeOptions({ modelPath, runner }))).rejects.toThrow(
      /execute exited with code 255/,
    );
  });

  it('throws when NMtran fails (RC=0 but no .lst, stdout contains "NMtran failed.")', async () => {
    const modelPath = path.join(tmp, 'm.mod');
    fs.writeFileSync(modelPath, '$PROBLEM x\n');
    // No m.lst written — simulating the NMtran-failure shape.
    const runner = new FakeRunner();
    runner.results.push({
      code: 0,
      stdout:
        'Starting 1 NONMEM executions. 1 in parallel.\nS:1 .. \nAll executions started.\nStarting NMTRAN\n' +
        ' \n AN ERROR WAS FOUND IN THE CONTROL STATEMENTS.\n' +
        ' \nAN ERROR WAS FOUND ON LINE 5 AT THE APPROXIMATE POSITION NOTED:\n' +
        ' Y = THETA(1) + GARBAGE_KEYWORD(1) + EPS(1)\n' +
        '                X              \n' +
        ' THE CHARACTERS IN ERROR ARE: GARBAGE_KEYWORD\n' +
        '  208  UNDEFINED VARIABLE.\n' +
        'NMtran failed. There is no output for model 1.\n' +
        'Not restarting this model.\n' +
        'F:1 .. \nexecute done\n' +
        'EXIT=0\n',
      stderr: '',
    });

    await expect(runModel(makeOptions({ modelPath, runner }))).rejects.toThrow(/NMtran failed/i);
  });

  it("throws with PsN's early-die message when an unknown $RECORD bails PsN before NMtran (e.g. $BAD_RECORD)", async () => {
    const modelPath = path.join(tmp, 'm.mod');
    fs.writeFileSync(modelPath, '$PROBLEM x\n');
    const runner = new FakeRunner();
    runner.results.push({
      code: 0,
      stdout: '',
      stderr:
        'PsN does not support record $BAD_RECORD in the control stream\n' +
        ' at /usr/local/share/perl/5.38.2/PsN_5_3_1/Mouse/PurePerl.pm line 302.\n',
    });

    await expect(runModel(makeOptions({ modelPath, runner }))).rejects.toThrow(
      /PsN does not support record \$BAD_RECORD in the control stream/,
    );
  });

  it('throws with the PsN config error when -nm_version is invalid (RC=2, no .lst)', async () => {
    const modelPath = path.join(tmp, 'm.mod');
    fs.writeFileSync(modelPath, '$PROBLEM x\n');
    const runner = new FakeRunner();
    runner.results.push({
      code: 0, // execute returns its own error to stdout/stderr; LocalRunner code is from the shell wrapper
      stdout: 'EXIT=2\n',
      stderr:
        'No NONMEM version with name "bogus" defined in psn.conf. ' +
        'Format should be: name=directory,version at /usr/local/share/perl/5.38.2/PsN_5_3_1/common_options.pm line 216.\n',
    });

    await expect(runModel(makeOptions({ modelPath, runner }))).rejects.toThrow(
      /No NONMEM version with name "bogus" defined in psn\.conf/,
    );
  });

  it('throws if .mod file does not exist', async () => {
    const runner = new FakeRunner();
    await expect(
      runModel(makeOptions({ modelPath: path.join(tmp, 'nope.mod'), runner })),
    ).rejects.toThrow(/model file not found/i);
    expect(runner.runs).toEqual([]);
  });

  it('passes -nm_version=<label> when nmVersionLabel is set', async () => {
    const modelPath = path.join(tmp, 'm.mod');
    fs.writeFileSync(modelPath, '$PROBLEM x\n');
    fs.writeFileSync(path.join(tmp, 'm.lst'), '');
    const runner = new FakeRunner();

    await runModel(makeOptions({ modelPath, runner, nmVersionLabel: '74' }));

    expect(runner.runs[0].command).toContain(`-nm_version=${quote('74')}`);
    expect(runner.runs[0].command).toContain(quote('m.mod'));
  });

  it("omits -nm_version when nmVersionLabel is undefined (PsN's bundled default applies)", async () => {
    const modelPath = path.join(tmp, 'm.mod');
    fs.writeFileSync(modelPath, '$PROBLEM x\n');
    fs.writeFileSync(path.join(tmp, 'm.lst'), '');
    const runner = new FakeRunner();

    await runModel(makeOptions({ modelPath, runner })); // nmVersionLabel intentionally absent

    expect(runner.runs[0].command).not.toContain('-nm_version');
  });

  it('passes -nm_output=ext,phi,cov,cor,coi,xml by default so PsN copies the NM7 aux files into modelfit_dirN/', async () => {
    const modelPath = path.join(tmp, 'm.mod');
    fs.writeFileSync(modelPath, '$PROBLEM x\n');
    fs.writeFileSync(path.join(tmp, 'm.lst'), '');
    const runner = new FakeRunner();

    await runModel(makeOptions({ modelPath, runner }));

    expect(runner.runs[0].command).toContain(`-nm_output=${quote('ext,phi,cov,cor,coi,xml')}`);
  });

  it('omits -nm_output when nmOutputExtensions is an empty array (caller opts out)', async () => {
    const modelPath = path.join(tmp, 'm.mod');
    fs.writeFileSync(modelPath, '$PROBLEM x\n');
    fs.writeFileSync(path.join(tmp, 'm.lst'), '');
    const runner = new FakeRunner();

    await runModel(makeOptions({ modelPath, runner, nmOutputExtensions: [] }));

    expect(runner.runs[0].command).not.toContain('-nm_output');
  });

  it('honors a custom nmOutputExtensions list', async () => {
    const modelPath = path.join(tmp, 'm.mod');
    fs.writeFileSync(modelPath, '$PROBLEM x\n');
    fs.writeFileSync(path.join(tmp, 'm.lst'), '');
    const runner = new FakeRunner();

    await runModel(makeOptions({ modelPath, runner, nmOutputExtensions: ['ext', 'phi'] }));

    expect(runner.runs[0].command).toContain(`-nm_output=${quote('ext,phi')}`);
  });

  it('returns the highest-N modelfit_dir<N> as modelfitDir when one (or more) exist', async () => {
    const modelPath = path.join(tmp, 'm.mod');
    fs.writeFileSync(modelPath, '$PROBLEM x\n');
    fs.writeFileSync(path.join(tmp, 'm.lst'), '');
    fs.mkdirSync(path.join(tmp, 'modelfit_dir1'));
    fs.mkdirSync(path.join(tmp, 'modelfit_dir2'));
    fs.mkdirSync(path.join(tmp, 'modelfit_dir10'));
    const runner = new FakeRunner();

    const result = await runModel(makeOptions({ modelPath, runner }));

    expect(result.modelfitDir).toBe(path.join(tmp, 'modelfit_dir10'));
  });

  it('returns modelfitDir=null when no modelfit_dir<N> directory was created', async () => {
    const modelPath = path.join(tmp, 'm.mod');
    fs.writeFileSync(modelPath, '$PROBLEM x\n');
    fs.writeFileSync(path.join(tmp, 'm.lst'), '');
    const runner = new FakeRunner();

    const result = await runModel(makeOptions({ modelPath, runner }));

    expect(result.modelfitDir).toBeNull();
  });

  it('ignores files / unrelated dirs when scanning for modelfit_dir<N>', async () => {
    const modelPath = path.join(tmp, 'm.mod');
    fs.writeFileSync(modelPath, '$PROBLEM x\n');
    fs.writeFileSync(path.join(tmp, 'm.lst'), '');
    fs.writeFileSync(path.join(tmp, 'modelfit_dir2'), ''); // file, not dir
    fs.mkdirSync(path.join(tmp, 'modelfit_dir1'));
    fs.mkdirSync(path.join(tmp, 'unrelated'));
    fs.mkdirSync(path.join(tmp, 'modelfit_dirX')); // non-numeric suffix
    const runner = new FakeRunner();

    const result = await runModel(makeOptions({ modelPath, runner }));

    expect(result.modelfitDir).toBe(path.join(tmp, 'modelfit_dir1'));
  });

  it("shell-quotes the .mod basename so spaces / quotes don't break the command", async () => {
    const modelPath = path.join(tmp, "o'brien.mod");
    fs.writeFileSync(modelPath, '$PROBLEM x\n');
    fs.writeFileSync(path.join(tmp, "o'brien.lst"), '');
    const runner = new FakeRunner();
    await runModel(makeOptions({ modelPath, runner }));
    // Embedded apostrophe gets the platform-specific quote treatment:
    // POSIX → `'o'\\''brien.mod'`; Windows cmd → `"o'brien.mod"`.
    expect(runner.runs[0].command).toContain(quote("o'brien.mod"));
  });
});
