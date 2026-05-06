import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseLastIteration,
  pollProgress,
  type ExtIteration,
} from '../../src/runtime/run-progress';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll-wait for `condition` to return a truthy value, up to `timeoutMs`.
 * Robust under parallel test load where fixed-sleep timings are flaky
 * (vitest's transform pipeline can stall the event loop briefly).
 */
async function waitFor(condition: () => boolean, timeoutMs = 2000, pollMs = 25): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return;
    await sleep(pollMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('parseLastIteration', () => {
  it('returns null on empty / whitespace input', () => {
    expect(parseLastIteration('')).toBeNull();
    expect(parseLastIteration('   \n\n  ')).toBeNull();
  });

  it('returns null when only headers are present', () => {
    const ext =
      'TABLE NO.  1: First Order Conditional Estimation\n' +
      'ITERATION    THETA1       OMEGA(1,1)   SIGMA(1,1)   OBJ\n';
    expect(parseLastIteration(ext)).toBeNull();
  });

  it('parses a single real iteration row (last column is OBJ)', () => {
    const ext =
      'ITERATION    THETA1       OMEGA(1,1)   SIGMA(1,1)   OBJ\n' +
      '       3     2.5000E+00   1.0000E+00   1.0000E+00   4.5305579106695500E+00\n';
    expect(parseLastIteration(ext)).toEqual({ iter: 3, ofv: 4.53055791066955 });
  });

  it('returns the LATEST iteration across multiple rows', () => {
    const ext =
      'ITERATION    THETA1   OBJ\n' +
      '       0     1.0      7.5\n' +
      '       3     2.5      4.5\n' +
      '       7     2.6      4.0\n';
    expect(parseLastIteration(ext)).toEqual({ iter: 7, ofv: 4.0 });
  });

  it('skips negative-iteration sentinel rows (-1000000000-class post-estimation markers)', () => {
    // NONMEM writes these after the real iterations to flag termination /
    // R/S-matrix output; iter is < 0 so we skip them and return the real last.
    const ext =
      'ITERATION    THETA1   OBJ\n' +
      '       5     2.5      4.5\n' +
      '   -1000000000     2.5      0.0\n' +
      '   -1000000007     1.34E+02 0.0\n';
    expect(parseLastIteration(ext)).toEqual({ iter: 5, ofv: 4.5 });
  });

  it('returns null when only sentinels exist (no real iterations yet)', () => {
    const ext = 'ITERATION    THETA1   OBJ\n' + '   -1000000000     2.5      0.0\n';
    expect(parseLastIteration(ext)).toBeNull();
  });
});

describe('pollProgress', () => {
  let tmp: string;

  // Real timers + short intervals: vi's fake timers don't pump real fs
  // I/O microtasks, and the poller awaits fs.readFile. Tests run fast
  // enough with 20-50ms intervals.
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * Build a modelfitDir layout matching PsN's default:
   *   <modelDir>/modelfit_dir1/NM_run1/psn.ext
   * and write `extContent` into psn.ext.
   */
  function seedExt(modelDir: string, extContent: string): string {
    const modelfitDir = path.join(modelDir, 'modelfit_dir1');
    const nmRun = path.join(modelfitDir, 'NM_run1');
    fs.mkdirSync(nmRun, { recursive: true });
    fs.writeFileSync(path.join(nmRun, 'psn.ext'), extContent);
    return modelfitDir;
  }

  it('emits the latest iteration on first tick, then again only when iter advances', async () => {
    seedExt(tmp, 'ITERATION    THETA1   OBJ\n       3     2.5      4.5\n');
    const calls: ExtIteration[] = [];
    const handle = pollProgress(tmp, (it) => calls.push(it), {
      intervalMs: 20,
      findModelfitDir: async (cwd) => path.join(cwd, 'modelfit_dir1'),
    });

    await waitFor(() => calls.length === 1);
    expect(calls).toEqual([{ iter: 3, ofv: 4.5 }]);

    // Append a new iteration → emitted on the next tick.
    fs.writeFileSync(
      path.join(tmp, 'modelfit_dir1', 'NM_run1', 'psn.ext'),
      'ITERATION    THETA1   OBJ\n' + '       3     2.5      4.5\n' + '       7     2.6      4.0\n',
    );
    await waitFor(() => calls.length === 2);
    expect(calls).toEqual([
      { iter: 3, ofv: 4.5 },
      { iter: 7, ofv: 4.0 },
    ]);

    handle.stop();
  });

  it('tolerates missing modelfit_dir / psn.ext silently and keeps polling', async () => {
    const calls: ExtIteration[] = [];
    const handle = pollProgress(tmp, (it) => calls.push(it), {
      intervalMs: 20,
      findModelfitDir: async () => null, // simulate "not yet created"
    });

    await sleep(120); // give a few ticks worth of time
    expect(calls).toEqual([]); // no throw, no emit
    handle.stop();
  });

  it('stops after stop() — no further onProgress calls', async () => {
    seedExt(tmp, 'ITERATION    THETA1   OBJ\n       3     2.5      4.5\n');
    const calls: ExtIteration[] = [];
    const handle = pollProgress(tmp, (it) => calls.push(it), {
      intervalMs: 20,
      findModelfitDir: async (cwd) => path.join(cwd, 'modelfit_dir1'),
    });

    await waitFor(() => calls.length === 1);

    handle.stop();
    fs.writeFileSync(
      path.join(tmp, 'modelfit_dir1', 'NM_run1', 'psn.ext'),
      'ITERATION    THETA1   OBJ\n       9     1.0      0.5\n',
    );
    await sleep(150); // long enough that several ticks would have fired
    expect(calls).toHaveLength(1);
  });
});
