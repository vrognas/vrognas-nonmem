// FileDecorationProvider for `.lst` files. Adds a small status badge
// (✓ / ✗ / ⚠) and a multi-line tooltip surfacing run summary so the
// user can hover an .lst in the explorer / Open Editors / breadcrumbs
// without opening it.
//
// Two-tier load to keep hover snappy:
//
//   1. Fast path — read+parse the .lst (filesystem, ~ms). Fire the
//      decoration with method, sig-digits, termination phrase. Cache.
//   2. Slow path — kick off `sumo` (SSH, 1–3 s). On completion, update
//      the cache and fire `_onDidChangeFileDecorations(uri)` so VS Code
//      re-asks us; the second answer carries OFV / runtime / cond /
//      status bullets.
//
// VS Code's `FileDecoration.tooltip` is a plain string — no Markdown.
// We compose newline-separated lines with Unicode glyphs.
//
// Cache key: `path -> { mtimeMs, decoration, sumoLoaded }`. mtime
// invalidation handles the "file got rewritten by a re-run" case.

import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { formatNumberCompact } from '../format-number';
import { errMsg } from '../log-utils';
import type { Runner } from '../runner';
import { parseLst, type LstSummary } from '../runtime/parse-lst';
import type { SumoSummary } from '../runtime/parse-sumo';
import { runSumo } from '../runtime/run-sumo';

interface CacheEntry {
  mtimeMs: number;
  decoration: vscode.FileDecoration | undefined;
  sumoLoaded: boolean;
  /**
   * Parsed `.lst` summary stashed on the fast path. Reused by
   * `loadSumoAndUpdate` instead of re-reading + re-parsing the file
   * from disk. Same mtime guard already protects freshness.
   */
  lst: LstSummary;
}

export class LstFileDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  private readonly cache = new Map<string, CacheEntry>();
  /** Tracks in-flight sumo invocations so we don't double-fire per file. */
  private readonly sumoInFlight = new Set<string>();

  /** FS watcher so the badge tracks live re-runs without an explorer hover. */
  private watcher: vscode.FileSystemWatcher | undefined;

  constructor(
    private readonly runner: Runner,
    /** Optional logger for parser/sumo failures during hover. */
    private readonly log: (message: string) => void = () => undefined,
  ) {
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*.lst');
    const invalidate = (uri: vscode.Uri): void => {
      this.cache.delete(uri.fsPath);
      this._onDidChange.fire(uri);
    };
    this.watcher.onDidCreate(invalidate);
    this.watcher.onDidChange(invalidate);
    this.watcher.onDidDelete(invalidate);
  }

  async provideFileDecoration(
    uri: vscode.Uri,
    _token: vscode.CancellationToken,
  ): Promise<vscode.FileDecoration | undefined> {
    const lstPath = uri.fsPath;
    if (!lstPath.endsWith('.lst')) return undefined;

    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(lstPath)).mtimeMs;
    } catch {
      return undefined;
    }

    const cached = this.cache.get(lstPath);
    if (cached && cached.mtimeMs === mtimeMs) {
      // Trigger sumo lazily on first hover when we still have the
      // lst-only decoration. Subsequent hovers reuse the rich one.
      if (!cached.sumoLoaded) void this.loadSumoAndUpdate(uri, mtimeMs);
      return cached.decoration;
    }

    let lstText: string;
    try {
      lstText = await fs.readFile(lstPath, 'utf8');
    } catch (e) {
      this.log(`lst-decoration: read failed for ${lstPath}: ${errMsg(e)}`);
      return undefined;
    }
    const lst = parseLst(lstText);
    const decoration = makeDecoration(lst, null);
    this.cache.set(lstPath, { mtimeMs, decoration, sumoLoaded: false, lst });
    void this.loadSumoAndUpdate(uri, mtimeMs);
    return decoration;
  }

  /**
   * Fire `sumo` against the .lst and update the cached decoration
   * once it returns. Idempotent per-path; coalesces concurrent calls.
   */
  private async loadSumoAndUpdate(uri: vscode.Uri, mtimeMs: number): Promise<void> {
    const lstPath = uri.fsPath;
    if (this.sumoInFlight.has(lstPath)) return;
    this.sumoInFlight.add(lstPath);
    let sumo: SumoSummary | null = null;
    try {
      sumo = await runSumo({ lstPath, runner: this.runner });
    } catch (e) {
      this.log(`lst-decoration: sumo failed for ${lstPath}: ${errMsg(e)}`);
    } finally {
      this.sumoInFlight.delete(lstPath);
    }
    // File may have been rewritten while sumo ran — bail if mtime moved.
    const cached = this.cache.get(lstPath);
    if (!cached || cached.mtimeMs !== mtimeMs) return;
    // Reuse the parsed LstSummary from the fast path (same mtime guard
    // proves freshness). Previously we re-read the .lst from disk +
    // re-parsed it, which doubled the IO cost per sumo cycle.
    const decoration = makeDecoration(cached.lst, sumo);
    this.cache.set(lstPath, { mtimeMs, decoration, sumoLoaded: true, lst: cached.lst });
    this._onDidChange.fire(uri);
  }

  dispose(): void {
    this._onDidChange.dispose();
    this.watcher?.dispose();
  }
}

/**
 * Compose a `FileDecoration` from parsed `.lst` + (optional) `sumo`
 * data. Returns undefined when neither source produced any signal.
 * Pure — no fs, no vscode imports beyond the type — unit-tested.
 */
export function makeDecoration(
  lst: LstSummary,
  sumo: SumoSummary | null,
): vscode.FileDecoration | undefined {
  const tooltip = buildLstTooltip(lst, sumo);
  if (tooltip === null) return undefined;
  return {
    badge: pickBadge(lst, sumo),
    tooltip,
    propagate: false,
  };
}

/**
 * Plain-text multi-line tooltip, terse:
 *
 *   FOCE-INTER · OFV = 6619.383
 *   runtime 0:00:32 (est 22.78s) · sig-digits 8 · cond 420.1 · 50000 obs · 2000 subj
 *   ✗ MINIMIZATION TERMINATED — DUE TO ROUNDING ERRORS (ERROR=134)
 *   ⚠ Large correlations between parameter estimates found
 *
 * Design choices:
 *   - method + OFV combined into the head line. VS Code already
 *     prepends the file path before our tooltip, so a separate path /
 *     method line was redundant.
 *   - termination phrase + reason go inline with an em-dash, not the
 *     phrase-then-indented-line layout we used for the markdown hover.
 *   - sumo OK statuses are dropped. The badge already says "all green
 *     vs problems"; listing six "✓ Hessian not reset" lines is noise.
 *     Only WARNING + ERROR statuses appear here.
 *
 * Returns null when nothing useful surfaced.
 */
export function buildLstTooltip(lst: LstSummary, sumo: SumoSummary | null): string | null {
  const lines: string[] = [];

  const ofvText = sumo && sumo.ofv !== null ? `OFV = ${formatNumberCompact(sumo.ofv)}` : '';
  const head = [lst.methodShort, ofvText].filter(Boolean).join(' · ');
  if (head) lines.push(head);

  const meta = metaLineParts(lst, sumo);
  if (meta.length > 0) lines.push(meta.join(' · '));

  if (lst.terminationPhrase) {
    const glyph = lst.termination === 'SUCCESSFUL' ? '✓' : '✗';
    const reason = lst.terminationReason ? lst.terminationReason.replace(/\s+/g, ' ').trim() : '';
    const phrase = reason ? `${lst.terminationPhrase} — ${reason}` : lst.terminationPhrase;
    lines.push(`${glyph} ${phrase}`);
  }

  if (sumo) {
    for (const s of sumo.statuses) {
      if (s.level === 'OK') continue; // noise; badge already conveys overall state
      lines.push(`${s.level === 'WARNING' ? '⚠' : '✗'} ${s.label}`);
    }
  }

  if (lines.length === 0) return null;
  return lines.join('\n');
}

/**
 * Pick a 1-2 char badge that reflects the dominant signal: error >
 * warning > success > unknown. Sumo statuses outrank lst termination
 * because they include cov-step / large-correlations checks which
 * sumo surfaces first-class and the .lst phrasing buries.
 */
export function pickBadge(lst: LstSummary, sumo: SumoSummary | null): string | undefined {
  if (sumo) {
    if (sumo.statuses.some((s) => s.level === 'ERROR')) return '✗';
    if (sumo.statuses.some((s) => s.level === 'WARNING')) return '⚠';
  }
  if (lst.termination === 'SUCCESSFUL') return '✓';
  if (lst.termination === 'TERMINATED') return '✗';
  return undefined;
}

function metaLineParts(lst: LstSummary, sumo: SumoSummary | null): string[] {
  const parts: string[] = [];
  if (sumo && sumo.totalRuntime) {
    let s = `runtime ${sumo.totalRuntime}`;
    if (typeof sumo.estimationSeconds === 'number') {
      s += ` (est ${formatNumberCompact(sumo.estimationSeconds)}s)`;
    }
    parts.push(s);
  }
  if (typeof lst.sigDigits === 'number') parts.push(`sig-digits ${formatNumberCompact(lst.sigDigits)}`);
  if (typeof lst.acceptanceRate === 'number') parts.push(`accept ${formatNumberCompact(lst.acceptanceRate)}`);
  if (sumo && typeof sumo.conditionNumber === 'number') {
    parts.push(`cond ${formatNumberCompact(sumo.conditionNumber)}`);
  }
  if (sumo && typeof sumo.observations === 'number') parts.push(`${sumo.observations} obs`);
  if (sumo && typeof sumo.individuals === 'number') parts.push(`${sumo.individuals} subj`);
  return parts;
}
