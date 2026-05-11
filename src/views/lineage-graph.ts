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
 * Default χ²₁,0.05 = 3.84. Significance threshold for nested 1-df ΔOFV
 * (Keizer 2013). User-configurable via `positronNonmem.lineageOfvThreshold`.
 * Exported so the lineage WebView's legend label can fall back to it
 * when no setting is provided.
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
  /**
   * Absolute path to the `.phi` (Pirana flat or PsN modelfit_dir<N>),
   * or null when missing / not emitted by the run's estimation methods.
   * Populated by the discovery layer; consumed by the panel-side lazy
   * `requestEdgeIOfv` handler (M11-Δi-B). Pure-graph nodes don't read it.
   */
  phiPath: string | null;
  /** File stem (no extension), used as a display label. */
  basename: string;
  /** `;; Description:` body from runrecord; null when absent. */
  description: string | null;
  /** `;; Label:` body from runrecord; null when absent. */
  label: string | null;
  /** OFV from `.ext` `-1000000000` row; null when not yet converged / aborted. */
  ofv: number | null;
  /**
   * Termination status from the `.lst` (parseLst). Drives the node's
   * border colour in the lineage view:
   *   - `'SUCCESSFUL'`  → green   (MINIMIZATION SUCCESSFUL / OPTIMIZATION COMPLETED)
   *   - `'TERMINATED'`  → red     (MINIMIZATION TERMINATED)
   *   - `null`          → gray    (no .lst yet, or parse failed to find phrase)
   */
  termination: 'SUCCESSFUL' | 'TERMINATED' | null;
  /**
   * First-token argument of `$DATA` from the .mod (basename only —
   * absolute paths get reduced to their leaf for display). Null when
   * no `$DATA` record. Surfaced on the node label so the user sees
   * which dataset each run used at a glance.
   */
  dataFile: string | null;
  /** `;; Based on: N` parent run number; null when no marker. */
  basedOn: number | null;
  /** False when `;; Based on: N [nodOFV]`; default true. */
  computeDeltaOfv: boolean;
  /**
   * Path-based parent override (workspace setting `lineageOverrides`).
   * When set, takes precedence over `basedOn`:
   *   - non-null string → parent is the node with this exact `modelPath`
   *   - null            → explicit root (suppress any `basedOn` marker)
   *   - undefined       → no override; fall back to `basedOn`
   * Lets users wire ANY two runs together (run002 → m.mod,
   * colistin.mod → run007, …) without the runrecord numeric-only
   * constraint.
   */
  basedOnPath?: string | null;
}

export interface LineageNode {
  runNumber: number | null;
  modelPath: string;
  lstPath: string | null;
  /** See `LineageNodeInput.phiPath`. */
  phiPath: string | null;
  basename: string;
  description: string | null;
  label: string | null;
  ofv: number | null;
  /** See `LineageNodeInput.termination`. */
  termination: 'SUCCESSFUL' | 'TERMINATED' | null;
  /** See `LineageNodeInput.dataFile`. */
  dataFile: string | null;
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
  /**
   * True when this edge was created by a workspace `lineageOverrides`
   * entry (`basedOnPath` set to a non-null string) rather than the
   * runrecord `;; Based on:` marker. Surfaced in the lineage view as a
   * dashed stroke so the user can tell file-canonical from workspace-
   * state edges at a glance.
   */
  viaOverride: boolean;
}

export interface LineageGraph {
  nodes: LineageNode[];
  /** Edges, parent→child, keyed by modelPath. */
  edges: LineageEdge[];
  /** modelPaths with no parent in the graph (origin nodes for layout). */
  roots: string[];
  /**
   * Diagnostic count: nodes with a non-null parent reference (`basedOn`
   * or `basedOnPath`) whose target couldn't be found in the input set.
   * Cycle nodes are NOT counted here — they have a different cause and
   * are surfaced separately. Drives the lineage view's "N unresolved
   * parent links" banner.
   */
  unresolvedParentCount: number;
}

export interface BuildLineageGraphOptions {
  /**
   * Significance threshold for ΔOFV edge colouring. Default 3.84
   * (χ²₁,0.05 — the Keizer 2013 convention). Set higher for a
   * stricter "improvement" definition (e.g. 6.63 = χ²₁,0.01).
   */
  chiSqThreshold?: number;
}

export function buildLineageGraph(
  inputs: readonly LineageNodeInput[],
  opts: BuildLineageGraphOptions = {},
): LineageGraph {
  // Dedupe by modelPath (the new canonical identity). Two run<NNN>.mod
  // files in different subdirs are now distinct nodes (paths differ);
  // duplicate paths still get first-wins.
  const byPath = new Map<string, LineageNodeInput>();
  for (const i of inputs) {
    if (!byPath.has(i.modelPath)) byPath.set(i.modelPath, i);
  }

  // Parent-resolution lookup: runNumber → modelPath. Built from inputs
  // that have a runNumber; non-numbered models can't be referenced as
  // a `;; Based on:` target. Duplicate run numbers (e.g. `popPK/run001.mod`
  // + `popPD/run001.mod` — common in multi-arm studies) are AMBIGUOUS:
  // any `;; Based on: 1` could refer to either. Rather than silently
  // wire to first-wins (the v0.0.196 behaviour) we exclude duplicates
  // from the lookup entirely. Affected children get an unresolved-parent
  // diagnostic and become roots until the user adds an explicit
  // `lineageOverride`.
  const pathByRunNumber = new Map<number, string>();
  const duplicateRunNumbers = new Set<number>();
  for (const i of byPath.values()) {
    if (i.runNumber === null) continue;
    if (duplicateRunNumbers.has(i.runNumber)) continue;
    if (pathByRunNumber.has(i.runNumber)) {
      pathByRunNumber.delete(i.runNumber);
      duplicateRunNumbers.add(i.runNumber);
      continue;
    }
    pathByRunNumber.set(i.runNumber, i.modelPath);
  }

  const nodes: LineageNode[] = [...byPath.values()].map((i) => ({
    runNumber: i.runNumber,
    modelPath: i.modelPath,
    lstPath: i.lstPath,
    phiPath: i.phiPath,
    basename: i.basename,
    description: i.description,
    label: i.label,
    ofv: i.ofv,
    termination: i.termination,
    dataFile: i.dataFile,
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
  let unresolvedParentCount = 0;
  for (const i of byPath.values()) {
    // Skip parent lookup only when this node is on a cycle or has no
    // parent reference at all. The previous `i.basedOn !== null` gate
    // missed nodes whose only parent reference is via the path override
    // (basedOnPath set, basedOn null) — those would silently become
    // roots even with a valid override.
    const hasParentRef = i.basedOn !== null || i.basedOnPath !== undefined;
    // Force-root overrides (`basedOnPath === null`) are intentional, not
    // unresolved — exclude them from the diagnostic count.
    const isForceRootOverride = i.basedOnPath === null;
    const parent =
      !onCycle.has(i.modelPath) && hasParentRef
        ? lookupParent(i, byPath, pathByRunNumber)
        : undefined;
    if (!parent) {
      if (
        hasParentRef &&
        !onCycle.has(i.modelPath) &&
        !isForceRootOverride
      ) {
        unresolvedParentCount++;
      }
      roots.push(i.modelPath);
      continue;
    }
    const { deltaOfv, color } = classifyEdge(
      parent.ofv,
      i.ofv,
      i.computeDeltaOfv,
      opts.chiSqThreshold ?? CHISQ_1DF_05,
    );
    edges.push({
      parentModelPath: parent.modelPath,
      childModelPath: i.modelPath,
      deltaOfv,
      color,
      // basedOnPath wins over basedOn in lookupParent; if it's a
      // non-null string and we got here, the override was the resolver.
      viaOverride: typeof i.basedOnPath === 'string',
    });
  }
  return { nodes, edges, roots, unresolvedParentCount };
}

/**
 * Predicate: would setting `childPath`'s parent to `parentPath` close a
 * cycle in the current edge set? Used by the panel before persisting an
 * override (drag-to-parent, Set parent…, Create relation…) so we can
 * reject the move with a toast instead of silently producing a tree
 * fragment via the `isOnCycle` ancestor walk inside `buildLineageGraph`.
 *
 * Algorithm: walk UP the existing parent chain from `parentPath`. Cycle
 * iff we hit `childPath` (which would mean `childPath` is already an
 * ancestor of `parentPath`, so the new edge closes the loop). Self-ref
 * (`childPath === parentPath`) returns true immediately. Walking up uses
 * the current `edges` (which are guaranteed acyclic — `buildLineageGraph`
 * drops cyclic edges) so the loop terminates.
 */
export function wouldOverrideCreateCycle(
  edges: readonly LineageEdge[],
  childPath: string,
  parentPath: string,
): boolean {
  if (parentPath === childPath) return true;
  const parentOf = new Map<string, string>();
  for (const e of edges) parentOf.set(e.childModelPath, e.parentModelPath);
  const seen = new Set<string>();
  let cur: string | undefined = parentPath;
  while (cur !== undefined) {
    if (cur === childPath) return true;
    if (seen.has(cur)) return false; // defensive — shouldn't happen on acyclic input
    seen.add(cur);
    cur = parentOf.get(cur);
  }
  return false;
}

/**
 * Resolve a node's parent. Order:
 *   1. `basedOnPath` override (workspace setting). Wins when set.
 *      `null` here means "explicit root, ignore basedOn".
 *   2. `basedOn` numeric runNumber (from runrecord `;; Based on:`).
 *
 * Returns undefined when no parent resolves OR the resolved parent is
 * the node itself (self-reference, would loop the renderer). The
 * returned node is the input itself rather than just the path so the
 * caller can read `parent.ofv`.
 */
function lookupParent(
  node: LineageNodeInput,
  byPath: ReadonlyMap<string, LineageNodeInput>,
  pathByRunNumber: ReadonlyMap<number, string>,
): LineageNodeInput | undefined {
  if (node.basedOnPath !== undefined) {
    if (node.basedOnPath === null) return undefined; // explicit root
    if (node.basedOnPath === node.modelPath) return undefined; // self-ref
    return byPath.get(node.basedOnPath);
  }
  if (node.basedOn === null) return undefined;
  const parentPath = pathByRunNumber.get(node.basedOn);
  if (!parentPath || parentPath === node.modelPath) return undefined;
  return byPath.get(parentPath);
}

/**
 * Walk the parent chain from `start` until we hit a node with no
 * resolvable parent (acyclic) or revisit a node we've already seen
 * (cycle, including self-reference). Honors `basedOnPath` overrides
 * so cycles introduced by user-set parents (e.g. setting A → B
 * after B was already → A) are caught. Returns true on cycle.
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
    if (!node) return false;
    // Follow same precedence as lookupParent: path override first,
    // then numeric basedOn.
    if (node.basedOnPath !== undefined) {
      if (node.basedOnPath === null) return false;
      currentPath = node.basedOnPath;
      continue;
    }
    if (node.basedOn === null) return false;
    currentPath = pathByRunNumber.get(node.basedOn);
  }
  return false;
}

function classifyEdge(
  parentOfv: number | null,
  childOfv: number | null,
  computeDeltaOfv: boolean,
  threshold: number,
): { deltaOfv: number | null; color: EdgeColor } {
  if (!computeDeltaOfv || parentOfv === null || childOfv === null) {
    return { deltaOfv: null, color: 'gray' };
  }
  const d = childOfv - parentOfv;
  if (d <= -threshold) return { deltaOfv: d, color: 'green' };
  if (d >= threshold) return { deltaOfv: d, color: 'red' };
  return { deltaOfv: d, color: 'yellow' };
}
