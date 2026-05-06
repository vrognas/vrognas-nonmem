// "NONMEM Runs" tree — hierarchical, file-explorer style. Discovered
// run dirs (folders containing one or more `.lst` files) are grouped
// by shared workspace-relative ancestors so common prefixes collapse
// into expandable folder nodes.
//
// Discovery is delegated to a function (defaults to
// `vscode.workspace.findFiles + fs.stat`) so tests can swap a fixture
// without spinning up a workspace. Tree shaping is in
// `runs-tree-builder.ts` — pure, separately tested.
import * as vscode from 'vscode';
import { errMsg } from '../log-utils';
import { discoverRuns, type RunDir } from './runs-discovery';
import { buildRunsTree, type RunsTreeNode } from './runs-tree-builder';

export type DiscoverFn = () => Promise<RunDir[]>;

/** Discriminated union so getTreeItem can dispatch tree nodes vs status messages. */
export type RunNode = { kind: 'tree'; node: RunsTreeNode } | MessageNode;

export class RunsTreeProvider implements vscode.TreeDataProvider<RunNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<RunNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Cached most-recent scan; cleared on refresh(). */
  private cache: RunsTreeNode[] | null = null;
  /** Last error from getChildren; surfaced as a single tree item so users see *something*. */
  private lastError: string | null = null;

  constructor(private readonly discover: DiscoverFn = discoverRuns) {}

  refresh(): void {
    this.cache = null;
    this.lastError = null;
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: RunNode): vscode.TreeItem {
    if (element.kind === 'message') return element.toTreeItem();
    return treeNodeToItem(element.node);
  }

  async getChildren(element?: RunNode): Promise<RunNode[]> {
    if (element) {
      if (element.kind === 'message') return [];
      return element.node.children.map((c) => ({ kind: 'tree', node: c }));
    }
    if (this.lastError) return [makeErrorNode(this.lastError)];
    if (!this.cache) {
      try {
        this.cache = buildRunsTree(await this.discover());
      } catch (e) {
        this.lastError = errMsg(e);
        return [makeErrorNode(this.lastError)];
      }
    }
    if (this.cache.length === 0) {
      return [makeMessageNode('No NONMEM runs found in workspace')];
    }
    return this.cache.map((n) => ({ kind: 'tree' as const, node: n }));
  }
}

/**
 * Render a `RunsTreeNode` as a TreeItem. Three flavours:
 *   - **Folder-only** (no `run`, has children): collapsible folder, no command.
 *   - **Run-only**    (has `run`, no children): leaf, click → open primary .lst.
 *   - **Hybrid**      (has both): collapsible AND clickable. VS Code routes
 *     label-click to the command and chevron-click to expand/collapse.
 */
function treeNodeToItem(node: RunsTreeNode): vscode.TreeItem {
  const hasChildren = node.children.length > 0;
  const collapsibleState = hasChildren
    ? vscode.TreeItemCollapsibleState.Collapsed
    : vscode.TreeItemCollapsibleState.None;
  const item = new vscode.TreeItem(node.label, collapsibleState);
  item.iconPath = new vscode.ThemeIcon('file-directory');
  if (node.run) {
    const lstUri = vscode.Uri.file(`${node.run.dirPath}/${node.run.primaryLst}`);
    item.description = node.run.primaryLst;
    item.tooltip = `${node.run.dirPath}\n${node.run.lstFiles.length} .lst file${node.run.lstFiles.length === 1 ? '' : 's'}`;
    item.contextValue = 'positronNonmem.run';
    item.resourceUri = vscode.Uri.file(node.run.dirPath);
    item.command = {
      command: 'vscode.open',
      title: 'Open',
      arguments: [lstUri],
    };
  } else {
    // Pure folder: no command, no description, no tooltip beyond the label.
    item.contextValue = 'positronNonmem.runFolder';
  }
  return item;
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
