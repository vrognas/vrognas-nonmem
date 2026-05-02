import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runModel, parseDataFilename } from '../../src/runtime/run-model';
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
    // Touch the destination file so callers reading it back don't ENOENT.
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, '');
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

describe('runModel — orchestrator (unit, with FakeTransport)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('uploads model + dataset, runs nmfe76, pulls m.lst back', async () => {
    const modelPath = path.join(tmp, 'm.mod');
    const datasetPath = path.join(tmp, 'd');
    fs.writeFileSync(
      modelPath,
      '$PROBLEM hello\n$INPUT ID TIME DV\n$DATA d\n$PRED Y=THETA(1)\n$THETA 1\n$OMEGA 0.1\n$SIGMA 0.1\n$ESTIMATION MAXEVAL=0\n',
    );
    fs.writeFileSync(datasetPath, 'ID TIME DV\n1 0 1.0\n');
    const localRunsDir = path.join(tmp, 'runs');
    const transport = new FakeTransport();

    const result = await runModel({
      modelPath,
      transport,
      remoteRoot: '~/positron-nonmem',
      localRunsDir,
      nmfeBinary: '/opt/nm760/run/nmfe76',
    });

    // 1 mkdir + 1 nmfe76 invocation.
    expect(transport.runs.length).toBe(2);
    expect(transport.runs[0]).toContain('mkdir -p');
    expect(transport.runs[0]).toContain(`~/positron-nonmem/${result.runId}`);
    expect(transport.runs[1]).toContain('cd ~/positron-nonmem/' + result.runId);
    expect(transport.runs[1]).toContain('/opt/nm760/run/nmfe76 m.mod m.lst');
    expect(transport.runs[1]).toContain('echo EXIT=$?');

    // m.mod uploaded to remote subdir as `m.mod`; dataset uploaded as `d`.
    expect(transport.puts).toEqual([
      { localPath: modelPath, remotePath: `~/positron-nonmem/${result.runId}/m.mod` },
      { localPath: datasetPath, remotePath: `~/positron-nonmem/${result.runId}/d` },
    ]);

    // m.lst pulled back to <localRunsDir>/<runId>/m.lst.
    expect(transport.gets).toEqual([
      {
        remotePath: `~/positron-nonmem/${result.runId}/m.lst`,
        localPath: path.join(localRunsDir, result.runId, 'm.lst'),
      },
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.runId).toMatch(/^pn-\d+$/);
    expect(result.lstPath).toBe(path.join(localRunsDir, result.runId, 'm.lst'));
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
