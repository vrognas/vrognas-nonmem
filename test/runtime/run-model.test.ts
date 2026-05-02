import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runModel, parseDataFilename, parseOfv } from '../../src/runtime/run-model';
import type { CommandResult, Transport } from '../../src/transport/types';

// ----- Test fixtures: tiny FakeTransport that records all calls and lets
// each test stub the next CommandResult. Mirrors the discipline from
// nonmem-ssh-probe (one change per test) — orchestrator behaviour is
// tested in isolation from any real ssh / scp.

interface PutCall {
  localPath: string;
  remotePath: string;
}
interface GetCall {
  remotePath: string;
  localPath: string;
}

class FakeTransport implements Transport {
  readonly kind = 'local' as const;
  readonly runs: string[] = [];
  readonly puts: PutCall[] = [];
  readonly gets: GetCall[] = [];
  /** Pop a canned result for each successive run() call. Defaults to EXIT=0. */
  readonly runResults: CommandResult[] = [];
  /**
   * Content provider for getFile. Receives the remote path; returns the
   * bytes to write locally, or undefined to write an empty file. Lets a
   * test stage canned content based on remote-path suffix without having
   * to know the runId ahead of time.
   */
  remoteFileFn: (remotePath: string) => string | undefined = () => undefined;
  /**
   * Optional error injector for getFile. If it returns an Error, getFile
   * rejects with it (simulates "file not found on remote", scp non-zero).
   */
  getErrorFn: (remotePath: string) => Error | undefined = () => undefined;

  async run(command: string): Promise<CommandResult> {
    this.runs.push(command);
    return (
      this.runResults.shift() ?? {
        code: 0,
        stdout: 'EXIT=0\n',
        stderr: '',
      }
    );
  }
  async putFile(localPath: string, remotePath: string): Promise<void> {
    this.puts.push({ localPath, remotePath });
  }
  async getFile(remotePath: string, localPath: string): Promise<void> {
    this.gets.push({ remotePath, localPath });
    const err = this.getErrorFn(remotePath);
    if (err) throw err;
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, this.remoteFileFn(remotePath) ?? '');
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
    // NONMEM treats `;` as start-of-comment. A `$DATA` inside a comment
    // is not an actual record. (Not bullet-proof for chunk 3A — first-
    // pass parser; promote later if it bites.)
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

  it('returns null when no #OBJV line is present (e.g. NMTRAN-only failure)', () => {
    expect(parseOfv('AN ERROR WAS FOUND IN THE CONTROL STATEMENTS.\n')).toBeNull();
  });
});

describe('runModel — orchestrator (unit, with FakeTransport)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('uploads model + dataset, runs nmfe76, pulls m.lst + m.ext, parses OFV', async () => {
    const modelPath = path.join(tmp, 'm.mod');
    const datasetPath = path.join(tmp, 'd');
    fs.writeFileSync(
      modelPath,
      '$PROBLEM hello\n$INPUT ID TIME DV\n$DATA d\n$PRED Y=THETA(1)\n$THETA 1\n$OMEGA 0.1\n$SIGMA 0.1\n$ESTIMATION MAXEVAL=0\n',
    );
    fs.writeFileSync(datasetPath, 'ID TIME DV\n1 0 1.0\n');
    const localRunsDir = path.join(tmp, 'runs');
    const transport = new FakeTransport();
    // Stage a realistic m.lst snippet — the #OBJV line is the machine-readable
    // OFV anchor (per supplements/nonmem-tips canonical probe output).
    const lstSnippet =
      ' #OBJT:**             FINAL VALUE OF OBJECTIVE FUNCTION             *********\n' +
      ' #OBJV:************************    -2.05421E+01    ************************\n' +
      ' #OBJS:************************        N/A         ************************\n';
    transport.remoteFileFn = (p) => (p.endsWith('/m.lst') ? lstSnippet : undefined);

    const result = await runModel({
      modelPath,
      transport,
      remoteRoot: '~/positron-nonmem',
      localRunsDir,
      nmfeBinary: '/opt/nm760/run/nmfe76',
    });

    expect(transport.runs.length).toBe(2);
    expect(transport.runs[0]).toContain('mkdir -p');
    expect(transport.runs[0]).toContain(`~/positron-nonmem/${result.runId}`);
    expect(transport.runs[1]).toContain('cd ~/positron-nonmem/' + result.runId);
    expect(transport.runs[1]).toContain('/opt/nm760/run/nmfe76 m.mod m.lst');
    expect(transport.runs[1]).toContain('echo EXIT=$?');

    expect(transport.puts).toEqual([
      { localPath: modelPath, remotePath: `~/positron-nonmem/${result.runId}/m.mod` },
      { localPath: datasetPath, remotePath: `~/positron-nonmem/${result.runId}/d` },
    ]);

    // Both m.lst AND m.ext are pulled back. m.lst feeds parseOfv; m.ext is
    // staged for 3D's Variables-pane wiring (we don't parse it yet).
    expect(transport.gets).toEqual([
      {
        remotePath: `~/positron-nonmem/${result.runId}/m.lst`,
        localPath: path.join(localRunsDir, result.runId, 'm.lst'),
      },
      {
        remotePath: `~/positron-nonmem/${result.runId}/m.ext`,
        localPath: path.join(localRunsDir, result.runId, 'm.ext'),
      },
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.runId).toMatch(/^pn-\d+$/);
    expect(result.lstPath).toBe(path.join(localRunsDir, result.runId, 'm.lst'));
    expect(result.extPath).toBe(path.join(localRunsDir, result.runId, 'm.ext'));
    expect(result.ofv).toBeCloseTo(-20.5421, 4);
  });

  it('parses non-zero EXIT from nmfe76 stdout', async () => {
    const modelPath = path.join(tmp, 'm.mod');
    fs.writeFileSync(modelPath, '$PROBLEM x\n$DATA d\n');
    fs.writeFileSync(path.join(tmp, 'd'), 'a\n');
    const transport = new FakeTransport();
    transport.runResults.push({ code: 0, stdout: '', stderr: '' }); // mkdir
    transport.runResults.push({
      code: 0,
      stdout: 'some nmfe noise\nEXIT=42\n',
      stderr: '',
    });

    const result = await runModel({
      modelPath,
      transport,
      remoteRoot: '~/positron-nonmem',
      localRunsDir: path.join(tmp, 'runs'),
      nmfeBinary: '/opt/nm760/run/nmfe76',
    });

    expect(result.exitCode).toBe(42);
  });

  it('tolerates missing m.ext (NMTRAN-only failure) — extPath null, m.lst still parsed', async () => {
    const modelPath = path.join(tmp, 'm.mod');
    fs.writeFileSync(modelPath, '$PROBLEM x\n$DATA d\n');
    fs.writeFileSync(path.join(tmp, 'd'), 'a\n');
    const transport = new FakeTransport();
    // Stage an m.lst that has a #OBJV line so we can prove parseOfv still runs.
    transport.remoteFileFn = (p) =>
      p.endsWith('/m.lst') ? ' #OBJV:****    7.5    ****\n' : undefined;
    // Make m.ext download fail the way scp would when the remote file
    // doesn't exist (NMTRAN-only failure: nmfe76 wrote m.lst but never
    // produced m.ext because estimation didn't start).
    transport.getErrorFn = (p) =>
      p.endsWith('/m.ext') ? new Error('scp exited 1: No such file or directory') : undefined;

    const result = await runModel({
      modelPath,
      transport,
      remoteRoot: '~/positron-nonmem',
      localRunsDir: path.join(tmp, 'runs'),
      nmfeBinary: '/opt/nm760/run/nmfe76',
    });

    expect(result.extPath).toBeNull();
    expect(result.lstPath).toContain('m.lst');
    expect(result.ofv).toBeCloseTo(7.5, 4);
    // Both gets were attempted; only the m.ext one failed.
    expect(transport.gets.map((g) => g.remotePath.split('/').pop())).toEqual(['m.lst', 'm.ext']);
  });

  it('throws if .mod file does not exist', async () => {
    const transport = new FakeTransport();
    await expect(
      runModel({
        modelPath: path.join(tmp, 'does-not-exist.mod'),
        transport,
        remoteRoot: '~/positron-nonmem',
        localRunsDir: path.join(tmp, 'runs'),
        nmfeBinary: '/opt/nm760/run/nmfe76',
      }),
    ).rejects.toThrow(/model file not found/i);
    // No remote calls should have been made.
    expect(transport.runs).toEqual([]);
    expect(transport.puts).toEqual([]);
    expect(transport.gets).toEqual([]);
  });
});
