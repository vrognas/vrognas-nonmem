// Pure lineage-graph builder. Given a list of `LineageNodeInput`
// (one per workspace model file) returns nodes + edges + roots, with
// edges colour-coded per Keizer 2013 Fig 4 / sec. 2.5 of the design plan.
//
// No fs, no vscode imports. Runs in vitest under Node and inside the
// extension host the same way. The discovery layer
// (`lineage-discovery.ts`) does the workspace walk and feeds inputs
// here.
//
// Identity model (changed in v0.0.79): nodes are keyed on `modelPath`,
// not `runNumber`. Every `.mod` / `.ctl` in the workspace becomes a
// node — Pirana-style `m.mod`, hand-rolled `colistin.mod`, etc. The
// `runNumber` becomes optional metadata used only for parent
// resolution (a `;; Based on: N` link can only resolve when the
// candidate parent has a numeric run number). Orphans / non-numbered
// models still appear as roots so the modeler can construct lineage
// in hindsight (planned: edit-run-notes UI to set basedOn manually).
//
// Edge color rules per Keizer 2013 ("ΔOFV improvement ≥ 3.84 = green"):
//   - gray   : computeDeltaOfv=false (`[nodOFV]` flag) OR either OFV
//              is missing
//   - green  : ΔOFV ≤ -3.84 (improvement; χ²₁,0.05 for nested 1-df)
//   - red    : ΔOFV ≥ +3.84 (worsening)
//   - yellow : |ΔOFV| < 3.84 (strictly inside the indifference zone)

/**
 * χ²₁,0.05 = 3.84. Significance threshold for nested 1-df ΔOFV
 * (Keizer 2013). Exported so the lineage WebView's legend stays in
 * sync with the classifier — single source of truth.
 */
export const CHISQ_1DF_05 = 3.84;

export interface LineageNodeInput {
  /**
   * Run number from `run<NNN>.mod` filename. Null for non-runrecord-
   * compatible names (Pirana `m.mod`, hand-rolled `colistin.mod`, etc).
   * Used only as a parent-resolution key; the canonical node identity
   * is `modelPath`.
   */
  runNumber: number | null;
  /** Absolute path to the `.mod` / `.ctl` file. Canonical node key. */
  modelPath: string;
  /** Absolute path to the sibling `.lst`, or null when no .lst on disk yet. */
  lstPath: string | null;
  /** File stem (no extension), used as a display label. */
  basename: string;
  /** `;; Description:` body from runrecord; null when absent. */
  description: string | null;
  /** `;; Label:` body from runrecord; null when absent. */
  label: string | null;
  /** OFV from `.ext` `-1000000000` row; null when not yet converged / aborted. */
  ofv: number | null;
  /** `;; Based on: N` parent run number; null when no marker. */
  basedOn: number | null;
  /** False when `;; Based on: N [nodOFV]`; default true. */
  computeDeltaOfv: boolean;
}

export interface LineageNode {
  runNumber: number | null;
  modelPath: string;
  lstPath: string | null;
  basename: string;
  description: string | null;
  label: string | null;
  ofv: number | null;
}

export type EdgeColor = 'green' | 'red' | 'yellow' | 'gray';

export interface LineageEdge {
  /** Parent's modelPath — the canonical node identity. */
  parentModelPath: string;
  /** Child's modelPath. */
  childModelPath: string;
  /** child OFV − parent OFV; null when computeDeltaOfv=false or either OFV missing. */
  deltaOfv: number | null;
  color: EdgeColor;
}

export interface LineageGraph {
  nodes: LineageNode[];
  /** Edges, parent→child, keyed by modelPath. */
  edges: LineageEdge[];
  /** modelPaths with no parent in the graph (origin nodes for layout). */
  roots: string[];
}

export function buildLineageGraph(inputs: readonly LineageNodeInput[]): LineageGraph {
  // Dedupe by modelPath (the new canonical identity). Two run<NNN>.mod
  // files in different subdirs are now distinct nodes (paths differ);
  // duplicate paths still get first-wins.
  const byPath = new Map<string, LineageNodeInput>();
  for (const i of inputs) {
    if (!byPath.has(i.modelPath)) byPath.set(i.modelPath, i);
  }

  // Parent-resolution lookup: runNumber → modelPath. Built from inputs
  // that have a runNumber; non-numbered models can't be referenced as
  // a `;; Based on:` target. First-wins on duplicate run numbers
  // (rare: same `run001.mod` in two subdirs).
  const pathByRunNumber = new Map<number, string>();
  for (const i of byPath.values()) {
    if (i.runNumber !== null && !pathByRunNumber.has(i.runNumber)) {
      pathByRunNumber.set(i.runNumber, i.modelPath);
    }
  }

  const nodes: LineageNode[] = [...byPath.values()].map((i) => ({
    runNumber: i.runNumber,
    modelPath: i.modelPath,
    lstPath: i.lstPath,
    basename: i.basename,
    description: i.description,
    label: i.label,
    ofv: i.ofv,
  }));

  // Cycle detection. A `;; Based on: M` link forms a cycle when the
  // chain of parents revisits a node. Cyclic nodes become roots — we
  // don't draw a back-edge into the renderer's recursion.
  const onCycle = new Set<string>();
  for (const i of byPath.values()) {
    if (isOnCycle(i.modelPath, byPath, pathByRunNumber)) onCycle.add(i.modelPath);
  }

  const edges: LineageEdge[] = [];
  const roots: string[] = [];
  for (const i of byPath.values()) {
    const parent =
      !onCycle.has(i.modelPath) && i.basedOn !== null
        ? lookupParent(i, byPath, pathByRunNumber)
        : undefined;
    if (!parent) {
      roots.push(i.modelPath);
      continue;
    }
    const { deltaOfv, color } = classifyEdge(parent.ofv, i.ofv, i.computeDeltaOfv);
    edges.push({
      parentModelPath: parent.modelPath,
      childModelPath: i.modelPath,
      deltaOfv,
      color,
    });
  }
  return { nodes, edges, roots };
}

/**
 * Resolve a node's parent via its `basedOn` runNumber. Returns
 * undefined when either (a) no basedOn marker, (b) basedOn references
 * a runNumber not present in the workspace, (c) the resolved parent
 * is the node itself (self-reference). The returned node is the input
 * itself rather than just the path so the caller can read `parent.ofv`.
 */
function lookupParent(
  node: LineageNodeInput,
  byPath: ReadonlyMap<string, LineageNodeInput>,
  pathByRunNumber: ReadonlyMap<number, string>,
): LineageNodeInput | undefined {
  if (node.basedOn === null) return undefined;
  const parentPath = pathByRunNumber.get(node.basedOn);
  if (!parentPath || parentPath === node.modelPath) return undefined;
  return byPath.get(parentPath);
}

/**
 * Walk the `basedOn` chain from `start` until either we hit a node
 * with no parent (acyclic) or revisit a node we've already seen
 * (cycle, including self-reference). Returns true on cycle. Tracks
 * visited paths since paths are now the identity.
 */
function isOnCycle(
  startPath: string,
  byPath: ReadonlyMap<string, LineageNodeInput>,
  pathByRunNumber: ReadonlyMap<number, string>,
): boolean {
  const seen = new Set<string>();
  let currentPath: string | undefined = startPath;
  while (currentPath !== undefined) {
    if (seen.has(currentPath)) return true;
    seen.add(currentPath);
    const node = byPath.get(currentPath);
    if (!node || node.basedOn === null) return false;
    currentPath = pathByRunNumber.get(node.basedOn);
  }
  return false;
}

function classifyEdge(
  parentOfv: number | null,
  childOfv: number | null,
  computeDeltaOfv: boolean,
): { deltaOfv: number | null; color: EdgeColor } {
  if (!computeDeltaOfv || parentOfv === null || childOfv === null) {
    return { deltaOfv: null, color: 'gray' };
  }
  const d = childOfv - parentOfv;
  if (d <= -CHISQ_1DF_05) return { deltaOfv: d, color: 'green' };
  if (d >= CHISQ_1DF_05) return { deltaOfv: d, color: 'red' };
  return { deltaOfv: d, color: 'yellow' };
}
