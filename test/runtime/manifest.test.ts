import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sha256File, writeManifest, type RunManifest } from '../../src/runtime/manifest';
import type {
  RemoteDirEntry,
  RemoteFileStat,
  Transport,
} from '../../src/transport/types';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fixtureManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: 'pn-1234',
    started: '2026-05-03T00:00:00.000Z',
    completed: '2026-05-03T00:00:05.000Z',
    exitCode: 0,
    ofv: -2.05421,
    modelHash: 'a'.repeat(64),
    datasetHash: 'b'.repeat(64),
    nmfeBinary: '/opt/nm760/run/nmfe76',
    nonmemVersion: '7.6.0',
    hostAlias: 'primary',
    ...overrides,
  };
}

/** Records writeFile/run/etc calls; default no-op behaviour is enough for these tests. */
class RecorderTransport implements Transport {
  readonly kind = 'local' as const;
  readonly writes: { remotePath: string; content: string }[] = [];
  async run(): Promise<{ code: number; stdout: string; stderr: string }> {
    return { code: 0, stdout: '', stderr: '' };
  }
  async putFile(): Promise<void> {}
  async getFile(): Promise<void> {}
  async writeFile(remotePath: string, content: string): Promise<void> {
    this.writes.push({ remotePath, content });
  }
  async readFile(): Promise<string> {
    return '';
  }
  async stat(): Promise<RemoteFileStat> {
    throw new Error('not used');
  }
  async readDirectory(): Promise<RemoteDirEntry[]> {
    throw new Error('not used');
  }
}

describe('sha256File', () => {
  it('hashes "hello" to the canonical sha256 (literal-bytes oracle)', async () => {
    const p = path.join(tmp, 'hello.txt');
    fs.writeFileSync(p, 'hello');
    expect(await sha256File(p)).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('hashes empty file to the canonical empty-input sha256', async () => {
    const p = path.join(tmp, 'empty.txt');
    fs.writeFileSync(p, '');
    expect(await sha256File(p)).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('writeManifest', () => {
  it('writes manifest.json under the remote run dir via the transport', async () => {
    const t = new RecorderTransport();
    const m = fixtureManifest();
    const out = await writeManifest(t, '~/positron-nonmem/pn-1234', m);
    expect(out).toBe('~/positron-nonmem/pn-1234/manifest.json');
    expect(t.writes).toHaveLength(1);
    expect(t.writes[0].remotePath).toBe('~/positron-nonmem/pn-1234/manifest.json');
    expect(JSON.parse(t.writes[0].content)).toEqual(m);
  });

  it('omits parentRunId when undefined (clean shape for first-gen runs)', async () => {
    const t = new RecorderTransport();
    await writeManifest(t, '/tmp/run', fixtureManifest());
    expect(t.writes[0].content).not.toContain('parentRunId');
  });

  it('includes parentRunId when provided (lineage chain)', async () => {
    const t = new RecorderTransport();
    await writeManifest(t, '/tmp/run', fixtureManifest({ parentRunId: 'pn-9999' }));
    expect(JSON.parse(t.writes[0].content).parentRunId).toBe('pn-9999');
  });

  it('NEVER serialises a hostname-shaped field (privacy hygiene)', async () => {
    const t = new RecorderTransport();
    await writeManifest(t, '/tmp/run', fixtureManifest());
    expect(t.writes[0].content).not.toMatch(/hostname/i);
  });
});
