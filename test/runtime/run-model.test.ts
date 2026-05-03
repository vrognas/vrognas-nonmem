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
import type { CommandResult, Transport } from '../../src/transport/types';

interface PutCall {
  localPath: string;
  remotePath: string;
}

class FakeTransport implements Transport {
  readonly kind = 'local' as const;
  readonly runs: string[] = [];
  readonly puts: PutCall[] = [];
  readonly writes: { remotePath: string; content: string }[] = [];
  readonly reads: string[] = [];
  readonly runResults: CommandResult[] = [];
  /** Per-path content for readFile. Returns undefined to simulate missing file (throws). */
  readContent: (remotePath: string) => string | undefined = () => undefined;

  async run(command: string): Promise<CommandResult> {
    this.runs.push(command);
    return this.runResults.shift() ?? { code: 0, stdout: 'EXIT=0\n', stderr: '' };
  }
  async putFile(localPath: string, remotePath: string): Promise<void> {
    this.puts.push({ localPath, remotePath });
  }
  async getFile(): Promise<void> {
    throw new Error('getFile must NOT be called — outputs stay remote');
  }
  async writeFile(remotePath: string, content: string): Promise<void> {
    this.writes.push({ remotePath, content });
  }
  async readFile(remotePath: string): Promise<string> {
    this.reads.push(remotePath);
    const c = this.readContent(remotePath);
    if (c === undefined) throw new Error(`fake: no such remote file ${remotePath}`);
    return c;
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

describe('runModel — orchestrator (unit, with FakeTransport)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function makeOptions(
    overrides: { modelPath: string; transport: Transport } & Partial<RunModelOptions>,
  ): RunModelOptions {
    return {
      remoteRoot: '~/positron-nonmem',
      nmfeBinary: '/opt/nm760/run/nmfe76',
      hostAlias: 'test-alias',
      nonmemVersion: '7.6.0',
      ...overrides,
    };
  }

  it('uploads model + dataset, runs nmfe76, reads remote m.lst for OFV, writes manifest remotely', async () => {
    const modelPath = path.join(tmp, 'm.mod');
    const datasetPath = path.join(tmp, 'd');
    fs.writeFileSync(
      modelPath,
      '$PROBLEM hello\n$INPUT ID TIME DV\n$DATA d\n$PRED Y=THETA(1)\n$THETA 1\n$OMEGA 0.1\n$SIGMA 0.1\n$ESTIMATION MAXEVAL=0\n',
    );
    fs.writeFileSync(datasetPath, 'ID TIME DV\n1 0 1.0\n');
    const transport = new FakeTransport();
    const lstSnippet =
      ' #OBJT:**             FINAL VALUE OF OBJECTIVE FUNCTION             *********\n' +
      ' #OBJV:************************    -2.05421E+01    ************************\n' +
      ' #OBJS:************************        N/A         ************************\n';
    transport.readContent = (p) => (p.endsWith('/m.lst') ? lstSnippet : undefined);

    const result = await runModel(makeOptions({ modelPath, transport }));

    expect(transport.runs.length).toBe(2);
    expect(transport.runs[0]).toContain('mkdir -p');
    expect(transport.runs[0]).toContain(`~/positron-nonmem/${result.runId}`);
    expect(transport.runs[1]).toContain('cd ~/positron-nonmem/' + result.runId);
    expect(transport.runs[1]).toContain('/opt/nm760/run/nmfe76 m.mod m.lst');

    expect(transport.puts).toEqual([
      { localPath: modelPath, remotePath: `~/positron-nonmem/${result.runId}/m.mod` },
      { localPath: datasetPath, remotePath: `~/positron-nonmem/${result.runId}/d` },
    ]);

    // m.lst is read via the transport, NOT downloaded.
    expect(transport.reads).toEqual([`~/positron-nonmem/${result.runId}/m.lst`]);

    // manifest is written to the remote run dir, not locally.
    expect(transport.writes).toHaveLength(1);
    expect(transport.writes[0].remotePath).toBe(
      `~/positron-nonmem/${result.runId}/manifest.json`,
    );
    const manifest = JSON.parse(transport.writes[0].content);
    expect(manifest.runId).toBe(result.runId);
    expect(manifest.exitCode).toBe(0);
    expect(manifest.ofv).toBeCloseTo(-20.5421, 4);
    expect(manifest.hostAlias).toBe('test-alias');
    expect(manifest.modelHash).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.datasetHash).toMatch(/^[a-f0-9]{64}$/);

    expect(result.exitCode).toBe(0);
    expect(result.runId).toMatch(/^pn-\d+$/);
    expect(result.remoteRunDir).toBe(`~/positron-nonmem/${result.runId}`);
    expect(result.manifestPath).toBe(`~/positron-nonmem/${result.runId}/manifest.json`);
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

    const result = await runModel(makeOptions({ modelPath, transport }));
    expect(result.exitCode).toBe(42);
  });

  it('tolerates absent m.lst (NMTRAN-only failure) — ofv is null, manifest still written', async () => {
    const modelPath = path.join(tmp, 'm.mod');
    fs.writeFileSync(modelPath, '$PROBLEM x\n$DATA d\n');
    fs.writeFileSync(path.join(tmp, 'd'), 'a\n');
    const transport = new FakeTransport();
    // readContent returns undefined → readFile throws → tryReadOfv → null.
    transport.readContent = () => undefined;

    const result = await runModel(makeOptions({ modelPath, transport }));

    expect(result.ofv).toBeNull();
    expect(transport.writes).toHaveLength(1); // manifest written even on failure
    expect(JSON.parse(transport.writes[0].content).ofv).toBeNull();
  });

  it('throws if .mod file does not exist', async () => {
    const transport = new FakeTransport();
    await expect(
      runModel(makeOptions({ modelPath: path.join(tmp, 'does-not-exist.mod'), transport })),
    ).rejects.toThrow(/model file not found/i);
    expect(transport.runs).toEqual([]);
    expect(transport.puts).toEqual([]);
    expect(transport.reads).toEqual([]);
    expect(transport.writes).toEqual([]);
  });
});
