// "NONMEM Runs" tree — flat list of run-directories under
// `positronNonmem.runs.root`, freshest first. Each row opens the dir's
// primary `.lst` via the `positron-nonmem://` FS provider when clicked.
//
// Chunk B (this file): flat list, click-to-open. Chunk C will add child
// file groups + status icons parsed from each `.lst`'s termination code.
import * as vscode from 'vscode';
import { RemoteFileSystemProvider } from '../fs/remote-fs-provider';
import type { Transport } from '../transport';
import { discoverRuns, type RunDir } from './runs-discovery';

export class RunsTreeProvider implements vscode.TreeDataProvider<RunNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<RunNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Cached most-recent scan; cleared on refresh(). */
  private cache: RunDir[] | null = null;
  /** Last error from getChildren; surfaced as a single tree item so users see *something*. */
  private lastError: string | null = null;

  constructor(
    private readonly transportFactory: () => Promise<Transport>,
    private readonly alias: string,
    /** Returns the configured remote root, re-read on each refresh so config changes take effect. */
    private readonly getRoot: () => string,
  ) {}

  refresh(): void {
    this.cache = null;
    this.lastError = null;
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: RunNode): vscode.TreeItem {
    return element.toTreeItem(this.alias);
  }

  async getChildren(element?: RunNode): Promise<RunNode[]> {
    if (element) return []; // flat list for chunk B
    if (this.lastError) return [makeErrorNode(this.lastError)];
    if (!this.cache) {
      try {
        this.cache = await discoverRuns(await this.transportFactory(), this.getRoot());
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        return [makeErrorNode(this.lastError)];
      }
    }
    if (this.cache.length === 0) {
      return [makeMessageNode(`No runs found under ${this.getRoot()}`)];
    }
    return this.cache.map((r) => new RunDirNode(r));
  }
}

/** Discriminated union via a `kind` getter so getTreeItem can dispatch cleanly. */
export type RunNode = RunDirNode | MessageNode;

class RunDirNode {
  readonly kind = 'run' as const;
  constructor(readonly run: RunDir) {}

  toTreeItem(alias: string): vscode.TreeItem {
    const label = this.run.relativePath || this.run.remotePath;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.tooltip = `${this.run.remotePath}\n${this.run.lstFiles.length} .lst file${this.run.lstFiles.length === 1 ? '' : 's'}`;
    item.description = this.run.primaryLst;
    item.iconPath = new vscode.ThemeIcon('file-directory');
    item.contextValue = 'positronNonmem.run';
    item.command = {
      command: 'vscode.open',
      title: 'Open',
      arguments: [
        RemoteFileSystemProvider.buildUri(alias, `${this.run.remotePath}/${this.run.primaryLst}`),
      ],
    };
    return item;
  }
}

class MessageNode {
  readonly kind = 'message' as const;
  constructor(
    readonly message: string,
    private readonly icon: string,
  ) {}

  toTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.message, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(this.icon);
    return item;
  }
}

function makeMessageNode(text: string): MessageNode {
  return new MessageNode(text, 'info');
}

function makeErrorNode(text: string): MessageNode {
  return new MessageNode(`Error: ${text}`, 'error');
}
