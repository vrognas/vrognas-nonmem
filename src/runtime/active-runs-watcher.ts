// Workspace-wide FS watcher that registers every PsN run in
// `ActiveRunsTracker`, regardless of how the run was launched (Run
// Current Model, Console-typed `execute …`, external terminal, etc).
//
// Discovery hinges on a single PsN-specific filesystem signature:
// `<modelfitDir>/NM_run1/psn.mod`. PsN creates this during its setup
// phase (well before NONMEM starts iterating), at every -clean and
// -directory variant. See docs/psn-notes.md "Clean-level effects" for
// the empirical matrix verifying this invariant.
//
// Completion is signalled by `<modelDir>/<basename>.lst` appearing —
// PsN copies psn.lst here at every clean level (verified 2026-05-04).
//
// Lives in `runtime/` (not `views/`) because it's the engine that
// fills the tracker — the in-flight-run state machine — not a
// vscode UI binding. The vscode FileSystemWatcher dependency is just
// a delivery mechanism for filesystem events.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { pathExists } from '../fs-utils';
import { findLatestModelfitDir, parseOfv } from './run-model';
import { pollProgress, type ProgressPoller } from './run-progress';
import { ActiveRunsTracker } from './active-runs-tracker';

export interface ActiveRunsWatcherDeps {
  tracker: ActiveRunsTracker;
  /** Output channel for diagnostic logging. Optional so unit tests can omit it. */
  log?: (message: string) => void;
}

export class ActiveRunsWatcher implements vscode.Disposable {
  /** Live pollers, keyed by runId. Stopped on completion or dispose. */
  private readonly pollers = new Map<string, ProgressPoller>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly tracker: ActiveRunsTracker;
  private readonly log: (message: string) => void;

  constructor(deps: ActiveRunsWatcherDeps) {
    this.tracker = deps.tracker;
    this.log = deps.log ?? ((): void => undefined);
    const psnModWatcher = vscode.workspace.createFileSystemWatcher('**/NM_run1/psn.mod');
    const lstWatcher = vscode.workspace.createFileSystemWatcher('**/*.lst');
    // .lst handler must listen to BOTH create AND change: when the user
    // re-runs a model, run001.lst already exists from the previous run
    // and PsN overwrites it (fires `change`, not `create`). The handler
    // is idempotent — if the matching run is already `done`, the
    // tracker.list().find(...state==='running') guard short-circuits.
    const handleLst = (uri: vscode.Uri): void => void this.handleLstCreate(uri);
    this.disposables.push(
      psnModWatcher,
      psnModWatcher.onDidCreate((uri) => void this.handlePsnModCreate(uri)),
      lstWatcher,
      lstWatcher.onDidCreate(handleLst),
      lstWatcher.onDidChange(handleLst),
    );
  }

  dispose(): void {
    for (const id of [...this.pollers.keys()]) {
      this.stopRunSideEffects(id);
    }
    for (const d of this.disposables) d.dispose();
  }

  /**
   * Stop and forget the per-run poller + stale-timeout for `runId`.
   * Idempotent — safe to call when neither is registered. Used by
   * `handleLstCreate` (run completed) and `dispose` (loop-applied
   * over all known runs).
   */
  private stopRunSideEffects(runId: string): void {
    const poller = this.pollers.get(runId);
    if (poller) {
      poller.stop();
      this.pollers.delete(runId);
    }
  }

  /**
   * `<modelfitDir>/NM_run1/psn.mod` was just created. Resolve the
   * model file PsN was invoked on, register a tracker entry, and
   * start polling psn.ext for live iteration progress.
   */
  private async handlePsnModCreate(uri: vscode.Uri): Promise<void> {
    this.log(`watcher: psn.mod created at ${uri.fsPath}`);
    const modelfitDir = path.dirname(path.dirname(uri.fsPath));
    const meta = await readModelMetadata(modelfitDir);
    if (!meta) {
      this.log(
        `watcher: skipped (no model name found in ${modelfitDir}/{model_NMrun_translation.txt,command.txt})`,
      );
      return;
    }
    // Prefer the absolute path from command.txt when present — that
    // skips the walk-up and is unambiguous when two distinct dirs each
    // contain `run<NNN>.mod` (rare, but the walk-up would attribute to
    // the wrong one).
    let modelPath: string;
    if (meta.absoluteHint && (await pathExists(meta.absoluteHint))) {
      modelPath = meta.absoluteHint;
    } else {
      const modelDir = await findCallingCwd(modelfitDir, meta.basename);
      if (!modelDir) {
        this.log(`watcher: skipped (could not find ${meta.basename} above ${modelfitDir})`);
        return;
      }
      modelPath = path.join(modelDir, meta.basename);
    }
    // Dedupe: runCurrentModel may have already registered this run via
    // its synchronous tracker.start path. Use the existing entry rather
    // than create a duplicate.
    const existing = this.tracker
      .list()
      .find((r) => r.modelPath === modelPath && r.state === 'running');
    const runId = existing ? existing.id : this.tracker.start(modelPath, modelfitDir);
    if (existing) this.log(`watcher: matched existing tracker entry ${runId} for ${modelPath}`);
    else this.log(`watcher: registered new tracker entry ${runId} for ${modelPath}`);
    // PsN may fire `psn.mod` more than once per run (setup re-touches the
    // file, modelfit_dir<N> creation events arrive late). Tear down any
    // prior poller / stale-timeout for this runId before reinstalling so
    // we don't leak setTimeout handles or run two pollers in parallel.
    this.stopRunSideEffects(runId);
    this.pollers.set(
      runId,
      pollProgress(path.dirname(modelPath), (it) => this.tracker.updateProgress(runId, it), {
        // We already know the modelfitDir — short-circuit the scan.
        findModelfitDir: async () => modelfitDir,
      }),
    );
  }

  /**
   * A `.lst` file under any workspace path was just created or changed.
   * Two cases produce a candidate match:
   *   - **top-level** `<modelDir>/<basename>.lst` — PsN's copy-back
   *     destination. Gets overwritten on every re-run (so we can't
   *     store this path as a stable reference).
   *   - **per-run**  `<modelDir>/modelfit_dir<N>/<basename>.lst` — PsN's
   *     preserved snapshot under -nm_output. Stable per-run.
   *
   * We use either to detect completion (whichever fires first triggers
   * the markCompleted), but always store the **per-run** path as the
   * tracker's `lstPath` so clicking an old "done" entry opens its own
   * snapshot rather than the latest re-run's overwritten content.
   */
  private async handleLstCreate(uri: vscode.Uri, retried = false): Promise<void> {
    const lstPath = uri.fsPath;
    const lstBasename = path.basename(lstPath);
    const lstDir = path.dirname(lstPath);
    const stem = lstBasename.replace(/\.lst$/, '');
    // PsN works with both `.mod` and `.ctl` model files, so the
    // tracker's modelPath might be either. Build candidates for both
    // extensions × both top-level/per-run layouts.
    const candidateModelPaths = ['.mod', '.ctl'].flatMap((ext) => [
      path.join(lstDir, stem + ext),
      path.join(path.dirname(lstDir), stem + ext),
    ]);
    const run = this.tracker
      .list()
      .find((r) => r.state === 'running' && candidateModelPaths.includes(r.modelPath));
    if (!run) return;
    // Race: PsN copies the .lst back to the top-level dir BEFORE copying
    // it under modelfit_dir<N>/. If we mark completed on the top-level
    // event and store that path, a re-run overwrites this entry's
    // history. When we know a `modelfitDir` but the per-run lst doesn't
    // exist yet, defer once and retry at +1 s — by then PsN's copy-back
    // has finished.
    const perRunLst = run.modelfitDir ? path.join(run.modelfitDir, lstBasename) : null;
    const perRunReady = perRunLst ? await pathExists(perRunLst) : false;
    if (perRunLst && !perRunReady && !retried) {
      setTimeout(() => void this.handleLstCreate(uri, true), 1000);
      return;
    }
    this.stopRunSideEffects(run.id);
    const preservedLst = perRunReady ? perRunLst! : lstPath;
    let ofv: number | null = null;
    try {
      ofv = parseOfv(await fs.readFile(preservedLst, 'utf8'));
    } catch {
      // file disappeared between watcher and read; leave OFV null.
    }
    const modelfitDir = run.modelfitDir ?? (await findLatestModelfitDir(path.dirname(lstPath)));
    this.tracker.markCompleted(run.id, ofv, modelfitDir, preservedLst);
  }
}

export interface ModelMetadata {
  /** Always present: the model file's basename, e.g. `run001.mod`. */
  basename: string;
  /**
   * Absolute path to the model file when command.txt was invoked with
   * one (Pirana / our extension always pass absolute paths). Null
   * otherwise — caller must walk up from modelfitDir to find the
   * containing directory.
   */
  absoluteHint: string | null;
}

/**
 * Read the model file's basename (and absolute-path hint when
 * available) from PsN's metadata files. Prefers `command.txt` because
 * it carries the literal CLI invocation — when the modelfile arg was
 * absolute, we get the unambiguous path. Falls back to
 * `model_NMrun_translation.txt` (basename-only). Returns null when
 * neither is readable or parseable.
 */
async function readModelMetadata(modelfitDir: string): Promise<ModelMetadata | null> {
  try {
    const text = await fs.readFile(path.join(modelfitDir, 'command.txt'), 'utf8');
    const result = parseCommandTxtWithHint(text);
    if (result) return result;
  } catch {
    // fall through to translation file
  }
  try {
    const text = await fs.readFile(path.join(modelfitDir, 'model_NMrun_translation.txt'), 'utf8');
    const name = parseTranslationFile(text);
    if (name) return { basename: name, absoluteHint: null };
  } catch {
    // fall through
  }
  return null;
}

const MODEL_EXT_RE = /\.(mod|ctl)$/i;

/**
 * Parse PsN's `model_NMrun_translation.txt`. Format is one row per
 * model: `<modelfile><whitespace>NM_run<N>`. We take the first valid
 * row's modelfile basename. Accepts `.mod` and `.ctl`.
 */
export function parseTranslationFile(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    if (tokens.length >= 2 && MODEL_EXT_RE.test(tokens[0])) return tokens[0];
  }
  return null;
}

/**
 * Parse PsN's `command.txt`. Format is the literal CLI invocation,
 * one line: `<execute-path> [<-flags>] <modelfile>`. We take the
 * last whitespace-separated token ending in `.mod`/`.ctl`. Returns
 * just the basename — preserved for back-compat with existing tests.
 * Use `parseCommandTxtWithHint` for the new absolute-path-aware shape.
 */
export function parseCommandTxt(text: string): string | null {
  return parseCommandTxtWithHint(text)?.basename ?? null;
}

/**
 * Like `parseCommandTxt` but also surfaces the absolute path hint
 * when the modelfile token was passed as an absolute path (Pirana,
 * positron-nonmem). Used to unambiguously resolve the modelDir
 * without a walk-up scan.
 */
export function parseCommandTxtWithHint(text: string): ModelMetadata | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const tok = tokens[i];
    if (!MODEL_EXT_RE.test(tok)) continue;
    return {
      basename: path.basename(tok),
      absoluteHint: path.isAbsolute(tok) ? tok : null,
    };
  }
  return null;
}

/**
 * Walk up from `modelfitDir` looking for the directory that contains
 * `modelBasename` (the modelDir — where the user invoked PsN from).
 * Handles every PsN -directory / -model_subdir / -model_dir_name
 * variant (the .mod always lives at some ancestor; how many levels
 * up depends on the flags).
 *
 * Capped at `maxDepth` levels to avoid escaping the workspace on
 * pathological layouts.
 */
export async function findCallingCwd(
  modelfitDir: string,
  modelBasename: string,
  maxDepth = 5,
): Promise<string | null> {
  let current = path.dirname(modelfitDir);
  for (let i = 0; i < maxDepth; i++) {
    if (await pathExists(path.join(current, modelBasename))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
