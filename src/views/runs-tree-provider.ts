// "NONMEM Runs" tree — flat list of run-directories in the workspace,
// freshest first. Each row opens the dir's primary `.lst` when clicked.
//
// Discovery is delegated to a function (defaults to vscode.workspace.findFiles +
// fs.stat) so tests can swap a fixture without spinning up a workspace.
import * as vscode from 'vscode';
import { discoverRuns, type RunDir } from './runs-discovery';

export type DiscoverFn = () => Promise<RunDir[]>;

export class RunsTreeProvider implements vscode.TreeDataProvider<RunNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<RunNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Cached most-recent scan; cleared on refresh(). */
  private cache: RunDir[] | null = null;
  /** Last error from getChildren; surfaced as a single tree item so users see *something*. */
  private lastError: string | null = null;

  constructor(private readonly discover: DiscoverFn = discoverRuns) {}

  refresh(): void {
    this.cache = null;
    this.lastError = null;
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: RunNode): vscode.TreeItem {
    return element.toTreeItem();
  }

  async getChildren(element?: RunNode): Promise<RunNode[]> {
    if (element) return []; // flat list
    if (this.lastError) return [makeErrorNode(this.lastError)];
    if (!this.cache) {
      try {
        this.cache = await this.discover();
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        return [makeErrorNode(this.lastError)];
      }
    }
    if (this.cache.length === 0) {
      return [makeMessageNode('No NONMEM runs found in workspace')];
    }
    return this.cache.map((r) => new RunDirNode(r));
  }
}

/** Discriminated union via a `kind` getter so getTreeItem can dispatch cleanly. */
export type RunNode = RunDirNode | MessageNode;

class RunDirNode {
  readonly kind = 'run' as const;
  constructor(readonly run: RunDir) {}

  toTreeItem(): vscode.TreeItem {
    const label = this.run.relativePath || this.run.dirPath;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.tooltip = `${this.run.dirPath}\n${this.run.lstFiles.length} .lst file${this.run.lstFiles.length === 1 ? '' : 's'}`;
    item.description = this.run.primaryLst;
    item.iconPath = new vscode.ThemeIcon('file-directory');
    item.contextValue = 'positronNonmem.run';
    item.resourceUri = vscode.Uri.file(this.run.dirPath);
    item.command = {
      command: 'vscode.open',
      title: 'Open',
      arguments: [vscode.Uri.file(`${this.run.dirPath}/${this.run.primaryLst}`)],
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
