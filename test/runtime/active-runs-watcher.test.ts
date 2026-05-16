import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseTranslationFile,
  parseCommandTxt,
  parseCommandTxtWithHint,
  findCallingCwd,
} from '../../src/runtime/active-runs-watcher';

describe('parseTranslationFile', () => {
  it('parses the canonical `<modelfile>   NM_run1` line', () => {
    expect(parseTranslationFile('run001.mod                              NM_run1\n')).toBe(
      'run001.mod',
    );
  });

  it('returns null for empty / whitespace input', () => {
    expect(parseTranslationFile('')).toBeNull();
    expect(parseTranslationFile('   \n\n  ')).toBeNull();
  });

  it('returns null when the first token does not look like a .mod file', () => {
    expect(parseTranslationFile('some-junk\tNM_run1\n')).toBeNull();
  });

  it('takes the first valid line, ignoring trailing junk', () => {
    expect(parseTranslationFile('run001.mod  NM_run1\nstale leftover\n')).toBe('run001.mod');
  });
});

describe('parseCommandTxt', () => {
  it('extracts the .mod argument from `/usr/local/bin/execute run001.mod`', () => {
    expect(parseCommandTxt('/usr/local/bin/execute run001.mod\n')).toBe('run001.mod');
  });

  it('extracts the .mod argument when -flags are present before the model', () => {
    expect(
      parseCommandTxt('/usr/local/bin/execute -nm_version=default -nm_output=ext,phi run001.mod\n'),
    ).toBe('run001.mod');
  });

  it('takes the basename when the .mod arg is a full path', () => {
    expect(parseCommandTxt('execute /work/run001.mod')).toBe('run001.mod');
  });

  it('returns null when no .mod token is present', () => {
    expect(parseCommandTxt('execute -h\n')).toBeNull();
    expect(parseCommandTxt('')).toBeNull();
  });

  it('accepts `.ctl` model files (PsN supports both, L1)', () => {
    expect(parseCommandTxt('/usr/local/bin/execute run001.ctl\n')).toBe('run001.ctl');
    expect(parseTranslationFile('run001.ctl   NM_run1\n')).toBe('run001.ctl');
  });
});

describe('parseCommandTxtWithHint', () => {
  it('exposes an absolute-path hint when the modelfile arg was absolute (B12)', () => {
    const out = parseCommandTxtWithHint('execute /abs/path/run001.mod');
    expect(out).toEqual({ basename: 'run001.mod', absoluteHint: '/abs/path/run001.mod' });
  });

  it('hint is null when the modelfile arg was just a basename', () => {
    const out = parseCommandTxtWithHint('execute run001.mod');
    expect(out).toEqual({ basename: 'run001.mod', absoluteHint: null });
  });
});

describe('findCallingCwd', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('finds the .mod file one level up (vanilla `modelfit_dir1/`)', async () => {
    fs.writeFileSync(path.join(tmp, 'run001.mod'), '');
    const modelfitDir = path.join(tmp, 'modelfit_dir1');
    fs.mkdirSync(modelfitDir);
    expect(await findCallingCwd(modelfitDir, 'run001.mod')).toBe(tmp);
  });

  it('finds the .mod file two levels up (`-model_subdir` adds `<modelstem>/`)', async () => {
    fs.writeFileSync(path.join(tmp, 'run001.mod'), '');
    const modelfitDir = path.join(tmp, 'run001', 'modelfit_dir1');
    fs.mkdirSync(modelfitDir, { recursive: true });
    expect(await findCallingCwd(modelfitDir, 'run001.mod')).toBe(tmp);
  });

  it('returns null when the .mod is nowhere up the chain (within depth)', async () => {
    const modelfitDir = path.join(tmp, 'a', 'b', 'c');
    fs.mkdirSync(modelfitDir, { recursive: true });
    expect(await findCallingCwd(modelfitDir, 'run001.mod')).toBeNull();
  });

  it('respects maxDepth (caps the walk)', async () => {
    fs.writeFileSync(path.join(tmp, 'run001.mod'), '');
    const modelfitDir = path.join(tmp, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'modelfit_dir1');
    fs.mkdirSync(modelfitDir, { recursive: true });
    // Default maxDepth=5 — too far; null. With maxDepth=10 — found.
    expect(await findCallingCwd(modelfitDir, 'run001.mod')).toBeNull();
    expect(await findCallingCwd(modelfitDir, 'run001.mod', 10)).toBe(tmp);
  });
});
