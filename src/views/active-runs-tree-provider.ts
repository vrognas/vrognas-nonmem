// "Active Runs" tree — sibling of the existing Runs tree, but rendered
// from `ActiveRunsTracker` instead of from .lst files on disk. Each
// entry shows a model launched via `Run Current Model` and updates
// live as the run transitions running → done/failed.
//
// View answers "what's running NOW (and what just finished this
// session)?" — complements the static `Runs` view which answers "what
// completed runs are on disk?".

import * as path from 'node:path';
import * as vscode from 'vscode';
import { COMMAND } from '../constants';
import type { ActiveRun, ActiveRunsTracker } from '../runtime/active-runs-tracker';

export class ActiveRunsTreeProvider implements vscode.TreeDataProvider<ActiveRun>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  /** Unsubscribe fn from `tracker.onDidChange` — vscode-free Listener pattern, not a vscode.Disposable. */
  private readonly unsubscribeTracker: () => void;

  constructor(private readonly tracker: ActiveRunsTracker) {
    // Store the unsubscribe so dispose() can release the back-reference
    // into the tracker. Otherwise a re-activated provider leaks the old
    // instance through the tracker's listener list.
    this.unsubscribeTracker = tracker.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  dispose(): void {
    this.unsubscribeTracker();
    this._onDidChangeTreeData.dispose();
  }

  getChildren(element?: ActiveRun): ActiveRun[] {
    if (element) return [];
    return [...this.tracker.list()];
  }

  getTreeItem(run: ActiveRun): vscode.TreeItem {
    const item = new vscode.TreeItem(
      path.basename(run.modelPath),
      vscode.TreeItemCollapsibleState.None,
    );
    item.iconPath = iconFor(run.state);
    item.description = describe(run);
    item.tooltip = tooltip(run);
    item.contextValue = `nonmem.activeRun.${run.state}`;
    // All entries route through one command keyed by run id; the handler
    // dispatches by state (running → live OUTPUT; done → final .lst;
    // failed → toast with parsed error). Keeps the tree provider
    // vscode-only and the policy in extension.ts.
    item.command = {
      command: COMMAND.openRun,
      title: 'Open run output',
      arguments: [run.id],
    };
    return item;
  }
}

function iconFor(state: ActiveRun['state']): vscode.ThemeIcon {
  switch (state) {
    case 'running':
      // Built-in spinning indicator.
      return new vscode.ThemeIcon('loading~spin');
    case 'done':
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
    case 'failed':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
  }
}

function describe(run: ActiveRun): string {
  if (run.state === 'running') {
    const elapsed = formatDuration(Date.now() - run.startedAt);
    if (typeof run.currentIter === 'number' && typeof run.currentOfv === 'number') {
      return `iter ${run.currentIter}, OFV=${run.currentOfv.toFixed(3)} · ${elapsed}`;
    }
    return `running for ${elapsed}`;
  }
  const elapsed = run.finishedAt ? formatDuration(run.finishedAt - run.startedAt) : '';
  // `.trim()` won't strip a trailing ` · ` if elapsed is empty —
  // filter out empty parts BEFORE joining so the separator only sits
  // between real content.
  if (run.state === 'done') {
    const ofv = typeof run.finalOfv === 'number' ? `OFV=${run.finalOfv}` : 'no OFV';
    return [ofv, elapsed].filter(Boolean).join(' · ');
  }
  // failed
  return ['failed', elapsed].filter(Boolean).join(' · ');
}

function tooltip(run: ActiveRun): string {
  // Show workspace-relative paths only — `modelPath` / `modelfitDir`
  // are absolute on Remote SSH and would leak the remote layout into
  // any screenshot of the Active Runs tooltip.
  const relModel = vscode.workspace.asRelativePath(run.modelPath, false);
  const lines = [relModel, `state: ${run.state}`, `started: ${formatTimestamp(run.startedAt)}`];
  if (run.finishedAt) lines.push(`finished: ${formatTimestamp(run.finishedAt)}`);
  if (typeof run.finalOfv === 'number') lines.push(`OFV: ${run.finalOfv}`);
  if (run.modelfitDir) {
    const relDir = vscode.workspace.asRelativePath(run.modelfitDir, false);
    lines.push(`run dir: ${relDir}`);
  }
  if (run.errorMessage) lines.push(`error: ${run.errorMessage}`);
  return lines.join('\n');
}

/**
 * `YYYY-MM-DD HH:MM:SS` in local time, 24-hour. Prefer this over
 * `toLocaleString()` for tooltip / log content — locale-stable so
 * users / docs / screenshots match across machines.
 */
export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  return `${minutes}m ${remSeconds}s`;
}
