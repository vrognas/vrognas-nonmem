// Live iteration tracking for in-flight NONMEM runs.
//
// Two pieces:
//   1. `parseLastIteration` — pure parser over PsN's `psn.ext` file.
//      One row per iteration; first column is iteration number, last
//      is OBJ (objective-function value). Negative iterations (e.g.
//      -1000000000) are post-estimation sentinels NONMEM writes for
//      termination markers and R/S-matrix dumps — we skip them.
//   2. `pollProgress` — periodic poll loop driven by setTimeout.
//      Reads `<modelfit_dir<N>>/NM_run1/psn.ext`, parses the latest
//      real iteration, fires `onProgress` only when iter advances.
//      Tolerates the file (and its parent dir) not existing yet —
//      common during PsN's compile / setup phase before NONMEM starts.
//
// Used by `ActiveRunsWatcher`: spawns one poller per discovered run
// (registered via the `**/NM_run1/psn.mod` FS event), stops it when
// the matching `.lst` appears or the watcher is disposed. The Active
// Runs tree's description re-renders from `tracker.updateProgress`
// callbacks.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { findLatestModelfitDir } from './run-model';

export interface ExtIteration {
  /** Iteration number from `psn.ext` column 1 (>= 0). */
  iter: number;
  /** Objective-function value from the last column of `psn.ext`. */
  ofv: number;
}

/**
 * Parse the latest non-sentinel iteration row from `psn.ext`. Returns
 * null when the file has only header lines or only sentinels (run not
 * yet past iteration 0). The OBJ column is taken as the last
 * whitespace-separated token; NONMEM 7 always places it there.
 */
export function parseLastIteration(extText: string): ExtIteration | null {
  let last: ExtIteration | null = null;
  for (const line of extText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split(/\s+/);
    if (cols.length < 2) continue;
    // Iteration column must be a bare integer — rejects header rows
    // ("ITERATION"), the `-1000000000`-style sentinels, AND SAEM/IMP
    // STAT-summary rows whose first column has been observed to carry
    // non-integer floats in some NM 7.6 builds.
    if (!/^\d+$/.test(cols[0])) continue;
    const iter = Number(cols[0]);
    const ofv = Number(cols[cols.length - 1]);
    if (!Number.isFinite(ofv)) continue;
    last = { iter, ofv };
  }
  return last;
}

export interface PollProgressOptions {
  /** Poll interval in ms. Default 500 — fast enough to feel live, cheap on local fs. */
  intervalMs?: number;
  /**
   * Function used to discover the modelfit_dir for the run. Defaults to
   * `findLatestModelfitDir` (scans for highest-N modelfit_dir<N>). Tests
   * inject a stub to avoid the real fs scan.
   */
  findModelfitDir?: (modelDir: string) => Promise<string | null>;
}

export interface ProgressPoller {
  /** Idempotent. After stop(), no further `onProgress` calls fire. */
  stop(): void;
}

/**
 * Start polling `<modelDir>/modelfit_dir<N>/NM_run1/psn.ext` for new
 * iterations. `onProgress` fires only when the latest iteration number
 * advances; same-iter updates are deduplicated. The poller silently
 * tolerates missing files (PsN setup phase) and missing modelfit_dir
 * (run not yet started); it just keeps trying on the next tick.
 */
export function pollProgress(
  modelDir: string,
  onProgress: (it: ExtIteration) => void,
  options: PollProgressOptions = {},
): ProgressPoller {
  const intervalMs = options.intervalMs ?? 500;
  const findModelfitDir = options.findModelfitDir ?? findLatestModelfitDir;
  let stopped = false;
  let lastIter = -1;
  let timer: NodeJS.Timeout | null = null;

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const modelfitDir = await findModelfitDir(modelDir);
      if (stopped) return;
      if (modelfitDir) {
        const text = await fs.readFile(path.join(modelfitDir, 'NM_run1', 'psn.ext'), 'utf8');
        if (stopped) return;
        const latest = parseLastIteration(text);
        if (latest && latest.iter > lastIter) {
          lastIter = latest.iter;
          onProgress(latest);
        }
      }
    } catch {
      // Expected: psn.ext doesn't exist yet, or got cleaned up post-run.
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  }

  timer = setTimeout(() => void tick(), intervalMs);
  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
