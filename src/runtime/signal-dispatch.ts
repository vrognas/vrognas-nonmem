// Send a NONMEM signal file (`next.sig` / `stop.sig` / `print.sig`)
// into the cwd where nmfe76 is running. NONMEM polls its cwd at each
// PRINT cycle and consumes the file (deletes it) when noticed —
// verified empirically against NONMEM 7.6.0; see
// docs/empirical-notes.md "Signal-file mechanism" section.
//
// Under PsN's `execute`, nmfe76's cwd is `<modelfit_dir>/NM_run1/`.
// Signals are zero-byte files; an `fs.writeFile(path, '')` is the
// idiomatic path. Returns ok=false (no throw) on the common failure
// modes — caller decides how to surface (toast / log / both).
//
// LOCAL ONLY for now. The current run pipeline (PsN execute via
// LocalRunner) puts NM_run1/ on the local filesystem. When SSH-driven
// runs land (M3+), this module will need a Runner-aware variant that
// SFTP-puts the file on the remote.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type SignalName = 'next.sig' | 'stop.sig' | 'print.sig' | 'paraprint.sig';

export interface SendSignalOptions {
  /**
   * PsN's `modelfit_dir<N>/` for the run. The signal lands at
   * `<modelfitDir>/NM_run1/<name>` — that's nmfe76's actual cwd, NOT
   * the .mod's parent directory (NONMEM ignores signals placed
   * elsewhere; see empirical-notes.md S4 probe).
   */
  modelfitDir: string;
  name: SignalName;
}

export interface SendSignalResult {
  /** Absolute path the signal file was written to. */
  path: string;
  ok: boolean;
  /** Set when ok=false; human-readable reason. */
  error?: string;
}

/**
 * Write an empty file at `<modelfitDir>/NM_run1/<name>`. Common
 * failure modes:
 *   - NM_run1/ doesn't exist yet (signal sent during PsN's pre-run
 *     setup before nmfe76 has been spawned). Caller should retry
 *     a few seconds later or surface "run not yet at the iteration
 *     loop".
 *   - Permission denied on the target dir (rare on local FS).
 */
export async function sendSignal(opts: SendSignalOptions): Promise<SendSignalResult> {
  const targetDir = path.join(opts.modelfitDir, 'NM_run1');
  const target = path.join(targetDir, opts.name);
  try {
    await fs.writeFile(target, '');
    return { path: target, ok: true };
  } catch (e) {
    return { path: target, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
