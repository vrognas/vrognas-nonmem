// Build a hierarchical tree from a flat list of RunDirs by grouping
// shared `relativePath` ancestors. Mirrors VS Code's file-explorer
// shape: every directory segment becomes a folder node, each leaf
// position holding its `RunDir` payload.
//
// A position can be BOTH a folder (it has children) AND a run
// (`<relPath>/<basename>.lst` lives there) — e.g. `slow/` has its own
// `run001.lst` plus child `modelfit_dirN/`s. The single-shape
// `RunsTreeNode` carries an optional `run` exactly for that case.
//
// Pure function; no vscode dependency. The provider wraps these
// nodes in TreeItems.

import type { RunDir } from './runs-discovery';

export interface RunsTreeNode {
  /** Last segment of the relative path — the label shown in the tree. */
  label: string;
  /** Workspace-relative path to this position. Empty for synthetic root. */
  relPath: string;
  /** Set when a `RunDir` lives at this exact path (clickable leaf-or-mid). */
  run?: RunDir;
  /** Subdir nodes; sorted alphabetically (case-insensitive). */
  children: RunsTreeNode[];
}

/**
 * Group `runs` by their `relativePath` ancestors into a tree. Returns
 * the top-level nodes (children of the synthetic root). Stable
 * alphabetical sort at every level so re-renders don't reshuffle.
 */
export function buildRunsTree(runs: readonly RunDir[]): RunsTreeNode[] {
  const root: RunsTreeNode = { label: '', relPath: '', children: [] };
  for (const run of runs) {
    const segs = run.relativePath.split(/[/\\]/).filter(Boolean);
    if (segs.length === 0) {
      // Run lives at the workspace root itself.
      root.run = run;
      continue;
    }
    let node = root;
    let prefix = '';
    for (const seg of segs) {
      prefix = prefix ? `${prefix}/${seg}` : seg;
      let child = node.children.find((c) => c.label === seg);
      if (!child) {
        child = { label: seg, relPath: prefix, children: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.run = run;
  }
  sortInPlace(root);
  return root.children;
}

function sortInPlace(node: RunsTreeNode): void {
  node.children.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  for (const c of node.children) sortInPlace(c);
}
