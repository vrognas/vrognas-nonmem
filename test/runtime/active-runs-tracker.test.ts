import { describe, it, expect, vi, afterEach } from 'vitest';
import * as path from 'node:path';
import {
  ActiveRunsTracker,
  chooseRunAction,
  reconcileCompletion,
  reconcileFailure,
  type ActiveRun,
} from '../../src/runtime/active-runs-tracker';
import { formatTimestamp } from '../../src/views/active-runs-tree-provider';

// Global-restore guard: several tests below use `vi.useFakeTimers()`
// inline (the makeWatcherEntry helper + the list() ordering test).
// Without this guard, a failing assertion between useFakeTimers and
// useRealTimers would leak the fake timer system into every subsequent
// test in the file — silent test pollution.
afterEach(() => {
  vi.useRealTimers();
});

describe('ActiveRunsTracker', () => {
  it('start() registers a new run with state="running" and emits a change', () => {
    const tracker = new ActiveRunsTracker();
    const onChange = vi.fn();
    tracker.onDidChange(onChange);

    const id = tracker.start('/path/to/m.mod');

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(tracker.list()).toHaveLength(1);
    expect(tracker.list()[0]).toMatchObject({
      id,
      modelPath: '/path/to/m.mod',
      state: 'running',
    });
    expect(tracker.list()[0].startedAt).toBeGreaterThan(0);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('markCompleted() transitions a running run to "done" with ofv + modelfitDir + lstPath', () => {
    const tracker = new ActiveRunsTracker();
    const id = tracker.start('/m.mod');
    const onChange = vi.fn();
    tracker.onDidChange(onChange);

    tracker.markCompleted(id, 4.531, '/m/modelfit_dir1', '/m.lst');

    const run = tracker.list()[0];
    expect(run.state).toBe('done');
    expect(run.finalOfv).toBe(4.531);
    expect(run.modelfitDir).toBe('/m/modelfit_dir1');
    expect(run.lstPath).toBe('/m.lst');
    expect(run.finishedAt).toBeGreaterThan(0);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('markFailed() transitions a running run to "failed" with errorMessage', () => {
    const tracker = new ActiveRunsTracker();
    const id = tracker.start('/m.mod');
    const onChange = vi.fn();
    tracker.onDidChange(onChange);

    tracker.markFailed(id, 'NMtran failed: 208 UNDEFINED VARIABLE');

    const run = tracker.list()[0];
    expect(run.state).toBe('failed');
    expect(run.errorMessage).toBe('NMtran failed: 208 UNDEFINED VARIABLE');
    expect(run.finishedAt).toBeGreaterThan(0);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('list() returns most-recent first; multiple parallel runs all tracked', () => {
    const tracker = new ActiveRunsTracker();
    const a = tracker.start('/a.mod');
    // bump system time so b's startedAt > a's
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10);
    const b = tracker.start('/b.mod');
    vi.useRealTimers();

    const runs: readonly ActiveRun[] = tracker.list();
    expect(runs).toHaveLength(2);
    expect(runs[0].id).toBe(b);
    expect(runs[1].id).toBe(a);
  });

  it('formatTimestamp produces zero-padded YYYY-MM-DD HH:MM:SS in local time', () => {
    // Build a Date locally so the test is timezone-stable: pick local
    // 2026-05-04 09:07:03 and assert the formatter round-trips it.
    const ms = new Date(2026, 4, 4, 9, 7, 3).getTime(); // month is 0-indexed
    expect(formatTimestamp(ms)).toBe('2026-05-04 09:07:03');
  });

  it('updateProgress() sets currentIter/currentOfv for a running run + emits change', () => {
    const tracker = new ActiveRunsTracker();
    const id = tracker.start('/m.mod');
    const onChange = vi.fn();
    tracker.onDidChange(onChange);

    tracker.updateProgress(id, { iter: 47, ofv: 4.532 });

    const run = tracker.list()[0];
    expect(run.currentIter).toBe(47);
    expect(run.currentOfv).toBe(4.532);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('updateProgress() is a no-op once the run has transitioned out of running', () => {
    const tracker = new ActiveRunsTracker();
    const id = tracker.start('/m.mod');
    tracker.markCompleted(id, 4.5, '/m/modelfit_dir1', '/m.lst');

    const onChange = vi.fn();
    tracker.onDidChange(onChange);
    tracker.updateProgress(id, { iter: 99, ofv: 1.0 });

    const run = tracker.list()[0];
    expect(run.currentIter).toBeUndefined(); // never recorded
    expect(run.finalOfv).toBe(4.5); // completion data preserved
    expect(onChange).not.toHaveBeenCalled();
  });

  it('get(id) returns the registered run; undefined for an unknown id', () => {
    const tracker = new ActiveRunsTracker();
    const id = tracker.start('/x.mod');
    expect(tracker.get(id)?.modelPath).toBe('/x.mod');
    expect(tracker.get('does-not-exist')).toBeUndefined();
  });

  it('mark*() on an unknown id is a silent no-op (no throw, no spurious change event)', () => {
    const tracker = new ActiveRunsTracker();
    const onChange = vi.fn();
    tracker.onDidChange(onChange);

    expect(() => tracker.markCompleted('does-not-exist', 1, null, '/x.lst')).not.toThrow();
    expect(() => tracker.markFailed('does-not-exist', 'oops')).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
  });

  // Bounded-history eviction (v0.0.200). The cap is private but
  // `TERMINAL_HISTORY_CAP = 100` per the source; we exceed it modestly.
  describe('evictOldestTerminals (terminal history cap)', () => {
    function startAndComplete(tracker: ActiveRunsTracker, modelPath: string, finishedAt: number): string {
      const id = tracker.start(modelPath);
      vi.useFakeTimers();
      vi.setSystemTime(finishedAt);
      tracker.markCompleted(id, 1, null, `${modelPath}.lst`);
      vi.useRealTimers();
      return id;
    }

    it('keeps terminal entries while under the cap (100)', () => {
      const tracker = new ActiveRunsTracker();
      for (let i = 0; i < 50; i++) startAndComplete(tracker, `/m${i}.mod`, 1000 + i);
      expect(tracker.list()).toHaveLength(50);
    });

    it('evicts oldest terminal entries once over the cap', () => {
      const tracker = new ActiveRunsTracker();
      // 105 terminal entries; first 5 should evict on the 101st insert and beyond.
      for (let i = 0; i < 105; i++) startAndComplete(tracker, `/m${i}.mod`, 1000 + i);
      const runs = tracker.list();
      expect(runs).toHaveLength(100);
      // Survivors are the most-recently-finished — modelPaths /m5.mod through /m104.mod.
      const survivorPaths = new Set(runs.map((r) => r.modelPath));
      expect(survivorPaths.has('/m0.mod')).toBe(false);
      expect(survivorPaths.has('/m4.mod')).toBe(false);
      expect(survivorPaths.has('/m5.mod')).toBe(true);
      expect(survivorPaths.has('/m104.mod')).toBe(true);
    });

    it('NEVER evicts running entries even when cap exceeded', () => {
      const tracker = new ActiveRunsTracker();
      const liveId = tracker.start('/live.mod'); // running, must survive forever
      for (let i = 0; i < 105; i++) startAndComplete(tracker, `/m${i}.mod`, 1000 + i);
      const runs = tracker.list();
      // Running entry survives + 100 most-recent terminals = 101 total.
      expect(runs).toHaveLength(101);
      expect(runs.find((r) => r.id === liveId)?.state).toBe('running');
    });

    it('evicts on markFailed transitions too (not just markCompleted)', () => {
      const tracker = new ActiveRunsTracker();
      for (let i = 0; i < 101; i++) {
        const id = tracker.start(`/m${i}.mod`);
        vi.useFakeTimers();
        vi.setSystemTime(2000 + i);
        // Alternate completed/failed transitions.
        if (i % 2 === 0) tracker.markCompleted(id, 1, null, `/m${i}.lst`);
        else tracker.markFailed(id, 'err');
        vi.useRealTimers();
      }
      expect(tracker.list()).toHaveLength(100);
    });
  });
});

describe('chooseRunAction', () => {
  function makeRun(overrides: Partial<ActiveRun>): ActiveRun {
    return {
      id: 'r1',
      modelPath: '/work/m.mod',
      state: 'running',
      startedAt: 0,
      ...overrides,
    };
  }
  const findModelfitDir = (dir: string): Promise<string | null> =>
    Promise.resolve(path.join(dir, 'modelfit_dir1'));

  it('failed → showError with title, full body, and modelfitDir if available', async () => {
    const action = await chooseRunAction(
      makeRun({
        state: 'failed',
        errorMessage: 'NMtran failed: 208',
        modelfitDir: '/work/modelfit_dir1',
      }),
      findModelfitDir,
    );
    expect(action).toEqual({
      kind: 'showError',
      title: 'm.mod — run failed',
      body: 'NMtran failed: 208',
      modelfitDir: '/work/modelfit_dir1',
    });
  });

  it('failed without errorMessage → showError with generic fallback body', async () => {
    const action = await chooseRunAction(makeRun({ state: 'failed' }), findModelfitDir);
    expect(action.kind).toBe('showError');
    if (action.kind !== 'showError') return;
    expect(action.body).toBe('run failed (no error captured)');
  });

  it('running → open <modelfitDir>/NM_run1/OUTPUT (live iteration printout)', async () => {
    const action = await chooseRunAction(makeRun({ state: 'running' }), findModelfitDir);
    expect(action).toEqual({
      kind: 'open',
      path: path.join('/work', 'modelfit_dir1', 'NM_run1', 'OUTPUT'),
    });
  });

  it('running but findModelfitDir returns null → wait kind (modelfit_dir not yet created)', async () => {
    const action = await chooseRunAction(makeRun({ state: 'running' }), () =>
      Promise.resolve(null),
    );
    expect(action.kind).toBe('wait');
  });

  it('done → open run.lstPath when present', async () => {
    const action = await chooseRunAction(
      makeRun({ state: 'done', lstPath: '/work/m.lst' }),
      findModelfitDir,
    );
    expect(action).toEqual({ kind: 'open', path: '/work/m.lst' });
  });

  it('done without lstPath → derives it from modelPath (compat fallback)', async () => {
    const action = await chooseRunAction(makeRun({ state: 'done' }), findModelfitDir);
    expect(action).toEqual({ kind: 'open', path: path.join('/work', 'm.lst') });
  });

  it('snapshots run.state at entry — concurrent transition during await does not change branch', async () => {
    // Setup: a "running" run that gets mutated to "done" mid-await.
    const run = makeRun({ state: 'running' });
    const findModelfitDirRacy = (dir: string): Promise<string | null> => {
      // Mutate state BEFORE the resolver runs — simulates markCompleted
      // firing while we wait.
      run.state = 'done';
      run.lstPath = '/work/m.lst';
      return Promise.resolve(path.join(dir, 'modelfit_dir1'));
    };

    const action = await chooseRunAction(run, findModelfitDirRacy);

    // Should still get the running-branch result (NM_run1/OUTPUT) because
    // the snapshot was taken at entry, not after the await.
    expect(action).toEqual({
      kind: 'open',
      path: path.join('/work', 'modelfit_dir1', 'NM_run1', 'OUTPUT'),
    });
  });
});

describe('reconcileCompletion / reconcileFailure', () => {
  // Helper: pre-register a watcher-style entry and force its startedAt.
  // The "watcher already registered" tests need an entry that started
  // AT or AFTER our dispatchedAt — the timestamp window is what
  // disambiguates the current dispatch from any stale entries for the
  // same .mod.
  function makeWatcherEntry(
    tracker: ActiveRunsTracker,
    modelPath: string,
    startedAt: number,
  ): string {
    vi.useFakeTimers();
    vi.setSystemTime(startedAt);
    const id = tracker.start(modelPath);
    vi.useRealTimers();
    return id;
  }

  describe('reconcileCompletion', () => {
    it('found running entry → markCompleted (no duplicate)', () => {
      const tracker = new ActiveRunsTracker();
      const dispatchedAt = Date.now();
      const id = makeWatcherEntry(tracker, '/m.mod', dispatchedAt + 5);

      reconcileCompletion(tracker, {
        modelPath: '/m.mod',
        dispatchedAt,
        finalOfv: 4.5,
        modelfitDir: '/m/modelfit_dir1',
        lstPath: '/m.lst',
      });

      expect(tracker.list()).toHaveLength(1);
      const run = tracker.get(id)!;
      expect(run.state).toBe('done');
      expect(run.finalOfv).toBe(4.5);
    });

    it('found done entry (watcher raced ahead via lst handler) → no-op (no duplicate)', () => {
      // This is the regression that produced "32s + 0ms" in the UI:
      // the watcher's .lst handler completed the run before runModel.then,
      // and the old find-by-state===running missed it.
      const tracker = new ActiveRunsTracker();
      const dispatchedAt = Date.now();
      const id = makeWatcherEntry(tracker, '/m.mod', dispatchedAt + 5);
      tracker.markCompleted(id, 4.5, '/m/modelfit_dir1', '/m.lst');

      reconcileCompletion(tracker, {
        modelPath: '/m.mod',
        dispatchedAt,
        finalOfv: 4.5,
        modelfitDir: '/m/modelfit_dir1',
        lstPath: '/m.lst',
      });

      // Still ONE entry, not two.
      expect(tracker.list()).toHaveLength(1);
      // Original finishedAt preserved (no second markCompleted overwrite).
      expect(tracker.get(id)!.finalOfv).toBe(4.5);
    });

    it('no matching entry → synthetic-register + complete (watcher missed dispatch)', () => {
      const tracker = new ActiveRunsTracker();
      const dispatchedAt = Date.now();
      // Pre-existing stale entry from a previous run is OUTSIDE the window
      // (started before dispatchedAt) — must NOT be reused.
      makeWatcherEntry(tracker, '/m.mod', dispatchedAt - 5000);
      tracker.markCompleted(tracker.list()[0].id, 99, '/old', '/old.lst');

      reconcileCompletion(tracker, {
        modelPath: '/m.mod',
        dispatchedAt,
        finalOfv: 4.5,
        modelfitDir: '/m/modelfit_dir1',
        lstPath: '/m.lst',
      });

      const runs = tracker.list();
      expect(runs).toHaveLength(2); // stale + fresh synthetic
      // Most-recent first: synthetic with the fresh result.
      expect(runs[0].state).toBe('done');
      expect(runs[0].finalOfv).toBe(4.5);
      expect(runs[0].lstPath).toBe('/m.lst');
    });
  });

  describe('reconcileFailure', () => {
    it('found running entry → markFailed (no duplicate)', () => {
      const tracker = new ActiveRunsTracker();
      const dispatchedAt = Date.now();
      const id = makeWatcherEntry(tracker, '/m.mod', dispatchedAt + 5);

      reconcileFailure(tracker, {
        modelPath: '/m.mod',
        dispatchedAt,
        errorMessage: 'NMtran failed: 208',
      });

      expect(tracker.list()).toHaveLength(1);
      expect(tracker.get(id)!.state).toBe('failed');
      expect(tracker.get(id)!.errorMessage).toBe('NMtran failed: 208');
    });

    it('no matching entry → synthetic-register failed (PsN died before psn.mod)', () => {
      const tracker = new ActiveRunsTracker();
      const dispatchedAt = Date.now();

      reconcileFailure(tracker, {
        modelPath: '/m.mod',
        dispatchedAt,
        errorMessage: 'PsN does not support record $BAD_RECORD',
      });

      expect(tracker.list()).toHaveLength(1);
      expect(tracker.list()[0].state).toBe('failed');
    });
  });
});
