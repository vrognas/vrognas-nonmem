// In-flight NONMEM run tracker. Each `Run Current Model` invocation
// registers a new run here; the Active Runs tree view renders the
// list, and per-run state transitions (running → done/failed) drive
// view refresh through `onDidChange`.
//
// Lives independent of vscode so tests can exercise it without a vscode
// mock — the tree provider is the only consumer that bridges to vscode.

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

export type RunState = 'running' | 'done' | 'failed';

export interface ActiveRun {
  /** Stable id for the lifetime of this tracker instance. */
  id: string;
  /** Absolute path to the .mod control stream that was launched. */
  modelPath: string;
  state: RunState;
  /** Unix-ms timestamp when start() was called. */
  startedAt: number;
  /** Set when state transitions to done/failed. */
  finishedAt?: number;
  /** OFV parsed from the resulting .lst (null if NONMEM couldn't compute one). */
  finalOfv?: number | null;
  /** Path to the modelfit_dirN/ that holds NM7 aux files (null when not found). */
  modelfitDir?: string | null;
  /** Path to the produced `<basename>.lst`; only set when state === 'done'. */
  lstPath?: string;
  /** Latest iteration number observed during a running estimation; updated by pollProgress. */
  currentIter?: number;
  /** OFV at `currentIter`; updated by pollProgress. */
  currentOfv?: number;
  /** Human-readable failure message; only set when state === 'failed'. */
  errorMessage?: string;
}

type Listener = () => void;

export class ActiveRunsTracker {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly listeners = new Set<Listener>();

  /**
   * Register a new run and return its id. State starts at "running".
   * `modelfitDir` (optional) is the absolute path to the modelfit_dir<N>;
   * the FS watcher knows it from the discovered psn.mod path and
   * passes it through so click-to-OUTPUT and the live-progress poller
   * can find files without re-scanning.
   */
  start(modelPath: string, modelfitDir?: string): string {
    const id = randomUUID();
    this.runs.set(id, {
      id,
      modelPath,
      state: 'running',
      startedAt: Date.now(),
      ...(modelfitDir !== undefined ? { modelfitDir } : {}),
    });
    this.fire();
    return id;
  }

  markCompleted(
    id: string,
    finalOfv: number | null,
    modelfitDir: string | null,
    lstPath: string,
  ): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.state = 'done';
    run.finalOfv = finalOfv;
    run.modelfitDir = modelfitDir;
    run.lstPath = lstPath;
    run.finishedAt = Date.now();
    this.fire();
  }

  /**
   * Update the running run's latest iteration / OFV. No-op for any
   * state other than 'running' (we ignore late progress events that
   * race with markCompleted / markFailed).
   */
  updateProgress(id: string, progress: { iter: number; ofv: number }): void {
    const run = this.runs.get(id);
    if (!run) return;
    if (run.state !== 'running') return;
    run.currentIter = progress.iter;
    run.currentOfv = progress.ofv;
    this.fire();
  }

  markFailed(id: string, errorMessage: string): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.state = 'failed';
    run.errorMessage = errorMessage;
    run.finishedAt = Date.now();
    this.fire();
  }

  /** Snapshot, most-recent first. The view re-reads on every `onDidChange`. */
  list(): readonly ActiveRun[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Look up a single run by id; undefined when unknown. */
  get(id: string): ActiveRun | undefined {
    return this.runs.get(id);
  }

  /**
   * Subscribe to state-change events. Listeners fire after every
   * mutation (start, markCompleted, markFailed) so the consumer can
   * re-render. Returns a disposer.
   */
  onDidChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private fire(): void {
    for (const l of this.listeners) l();
  }
}

/**
 * Decision the click-handler takes for an Active Runs entry. Returned by
 * `chooseRunAction` so the side-effecting bits (open editor / show
 * error doc) live in extension.ts and the policy stays vscode-free.
 */
export type RunOpenAction =
  | { kind: 'open'; path: string }
  | { kind: 'showError'; title: string; body: string; modelfitDir?: string }
  | { kind: 'wait'; message: string };

/**
 * Pure decision: given an ActiveRun (and a way to find the modelfit_dir
 * for running runs), return what should happen on click.
 *
 * Snapshots `run.state` at entry so a concurrent transition during the
 * `findModelfitDir` await doesn't change which branch we land in — the user
 * clicked at one moment in time and should see the file appropriate
 * to that moment.
 */
export async function chooseRunAction(
  run: ActiveRun,
  findModelfitDir: (modelDir: string) => Promise<string | null>,
): Promise<RunOpenAction> {
  const state = run.state;
  if (state === 'failed') {
    return {
      kind: 'showError',
      title: `${path.basename(run.modelPath)} — run failed`,
      body: run.errorMessage ?? 'run failed (no error captured)',
      modelfitDir: run.modelfitDir ?? undefined,
    };
  }
  if (state === 'running') {
    const modelfitDir = await findModelfitDir(path.dirname(run.modelPath));
    if (!modelfitDir) {
      return { kind: 'wait', message: 'no output file yet — try again in a few seconds.' };
    }
    return { kind: 'open', path: path.join(modelfitDir, 'NM_run1', 'OUTPUT') };
  }
  // 'done' — prefer the lstPath captured at completion; fall back to
  // deriving it (covers older entries / missing field).
  return { kind: 'open', path: run.lstPath ?? deriveLstPath(run.modelPath) };
}

function deriveLstPath(modelPath: string): string {
  const base = path.basename(modelPath, path.extname(modelPath));
  return path.join(path.dirname(modelPath), base + '.lst');
}

/**
 * Reconcile a `runModel` promise resolution with the tracker so we
 * don't end up with a duplicate entry when the FS-watcher's `.lst`
 * handler raced ahead and already completed the run.
 *
 * Without this, the find-by-`state === 'running'` check at .then-time
 * misses the watcher's already-completed entry and synthetic-registers
 * a fresh one — visible to the user as a second Active Runs row with
 * `0ms` duration alongside the real one.
 *
 * Logic (shared with `reconcileFailure` via `findDispatchedRun`):
 *   - Look for ANY entry with this `modelPath` that started at or
 *     after `dispatchedAt` (= when runCurrentModel kicked off this
 *     run). That timestamp window discriminates the current dispatch
 *     from any stale `done`/`failed` rows for previous runs of the
 *     same .mod.
 *   - If found running → transition (markCompleted/markFailed).
 *   - If found already terminal → no-op (watcher's .lst handler did
 *     it; respecting the existing state preserves accurate elapsed
 *     time).
 *   - If not found → watcher genuinely missed the dispatch
 *     (out-of-workspace .mod, etc.); synthetic-register so the user
 *     always sees the run in Active Runs.
 */
export function reconcileCompletion(
  tracker: ActiveRunsTracker,
  args: {
    modelPath: string;
    dispatchedAt: number;
    finalOfv: number | null;
    modelfitDir: string | null;
    lstPath: string;
  },
): void {
  const existing = findDispatchedRun(tracker, args.modelPath, args.dispatchedAt);
  if (existing) {
    if (existing.state === 'running') {
      tracker.markCompleted(existing.id, args.finalOfv, args.modelfitDir, args.lstPath);
    }
    return;
  }
  const id = tracker.start(args.modelPath, args.modelfitDir ?? undefined);
  tracker.markCompleted(id, args.finalOfv, args.modelfitDir, args.lstPath);
}

/** Failure-path counterpart of `reconcileCompletion` — same window logic, markFailed instead of markCompleted. */
export function reconcileFailure(
  tracker: ActiveRunsTracker,
  args: { modelPath: string; dispatchedAt: number; errorMessage: string },
): void {
  const existing = findDispatchedRun(tracker, args.modelPath, args.dispatchedAt);
  if (existing) {
    if (existing.state === 'running') {
      tracker.markFailed(existing.id, args.errorMessage);
    }
    return;
  }
  const id = tracker.start(args.modelPath);
  tracker.markFailed(id, args.errorMessage);
}

/**
 * Find the tracker entry registered for a specific dispatch — the
 * watcher-or-synthetic row whose `startedAt` falls inside the
 * dispatchedAt-or-later window for `modelPath`. Returns undefined
 * when the watcher hasn't seen the run yet (caller will
 * synthetic-register).
 */
function findDispatchedRun(
  tracker: ActiveRunsTracker,
  modelPath: string,
  dispatchedAt: number,
): ActiveRun | undefined {
  return tracker.list().find((r) => r.modelPath === modelPath && r.startedAt >= dispatchedAt);
}
