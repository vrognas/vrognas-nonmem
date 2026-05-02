import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  sha256File,
  writeManifest,
  appendAudit,
  type RunManifest,
} from '../../src/runtime/manifest';

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

describe('sha256File', () => {
  it('hashes "hello" to the canonical sha256 (literal-bytes oracle)', async () => {
    const p = path.join(tmp, 'hello.txt');
    fs.writeFileSync(p, 'hello');
    // Independently verifiable: `printf hello | sha256sum`.
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
  it('writes a JSON file with all fields', async () => {
    const m = fixtureManifest();
    const out = await writeManifest(tmp, m);
    expect(out).toBe(path.join(tmp, 'manifest.json'));
    const parsed = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(parsed).toEqual(m);
  });

  it('omits parentRunId when undefined (clean shape for first-gen runs)', async () => {
    await writeManifest(tmp, fixtureManifest());
    const text = fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8');
    expect(text).not.toContain('parentRunId');
  });

  it('includes parentRunId when provided (lineage chain)', async () => {
    await writeManifest(tmp, fixtureManifest({ parentRunId: 'pn-9999' }));
    const parsed = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'));
    expect(parsed.parentRunId).toBe('pn-9999');
  });

  it('NEVER serialises a hostname-shaped field (privacy hygiene)', async () => {
    // Belt-and-braces: the type doesn't permit it, but make sure no caller
    // can leak through some future "extra fields" path.
    const m = fixtureManifest();
    await writeManifest(tmp, m);
    const text = fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8');
    expect(text).not.toMatch(/hostname/i);
  });
});

describe('appendAudit', () => {
  it('appends one JSON line per call (creates file if missing)', async () => {
    const log = path.join(tmp, 'audit.jsonl');
    await appendAudit(log, fixtureManifest({ runId: 'pn-1' }));
    await appendAudit(log, fixtureManifest({ runId: 'pn-2' }));

    const lines = fs.readFileSync(log, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).runId).toBe('pn-1');
    expect(JSON.parse(lines[1]).runId).toBe('pn-2');
  });

  it('creates parent directories on first append', async () => {
    const log = path.join(tmp, 'nested', 'subdir', 'audit.jsonl');
    await appendAudit(log, fixtureManifest());
    expect(fs.existsSync(log)).toBe(true);
  });
});
