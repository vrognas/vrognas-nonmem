// Lineage WebView client (d3-hierarchy + plain SVG renderer).
//
// Replaces the prior cytoscape implementation. d3-hierarchy is the
// canonical tool for parent-child trees: `d3.tree()` runs the
// Reingold-Tilford algorithm and returns x/y for each node, we render
// `<g>` per node + `<path>` per edge directly into an SVG sized to
// the layout extent. Native browser scrollbars work out of the box
// (SVG-inside-`overflow:auto`); native click + contextmenu on `<g>`
// elements; CSS variables work directly via the `style` attribute.
// Bundle is ~10 KB (was 530 KB with cytoscape).
//
// Wire format unchanged — `LineageGraph` from extension still drives
// rendering. Receives `{ type: 'graph', graph }` over postMessage.
//
// User input:
//   - left-click a node       → postMessage('open', modelPath)
//   - right-click a node      → custom HTML ctx menu at cursor
//   - plain wheel             → wrap.scrollBy (browser pan)
//   - ctrl/⌘ + wheel          → zoom (scale SVG width/height; native
//                               scrollbars track the new size)

import { hierarchy, tree, type HierarchyPointNode } from 'd3-hierarchy';
import { linkVertical } from 'd3-shape';

// Wire-format mirror — keep in sync with `src/views/lineage-graph.ts`.
type EdgeColor = 'green' | 'red' | 'yellow' | 'gray';
interface LineageNode {
  runNumber: number | null;
  modelPath: string;
  lstPath: string | null;
  basename: string;
  description: string | null;
  label: string | null;
  ofv: number | null;
  termination: 'SUCCESSFUL' | 'TERMINATED' | null;
  dataFile: string | null;
}

interface LineageOption {
  /** Empty string = "All Runs (workspace)"; named lineages are non-empty. */
  name: string;
  label: string;
}
interface LineageEdge {
  parentModelPath: string;
  childModelPath: string;
  deltaOfv: number | null;
  color: EdgeColor;
  /** True iff the edge came from a workspace `lineageOverrides` entry
   *  rather than a runrecord `;; Based on:` marker. Renders dashed. */
  viaOverride: boolean;
}
interface LineageGraph {
  nodes: LineageNode[];
  edges: LineageEdge[];
  roots: string[];
  /** See `LineageGraph.unresolvedParentCount` in lineage-graph.ts. */
  unresolvedParentCount: number;
}

/** Wire-shape for `lineage-discovery.ts:StaleOverride`. */
interface StaleOverride {
  childPath: string;
  parentPath: string | null;
  reason: 'child-missing' | 'parent-missing';
}

interface VsCodeApi {
  postMessage(msg: unknown): void;
  setState(state: unknown): void;
  getState(): unknown;
}
declare function acquireVsCodeApi(): VsCodeApi;

// ---- DOM refs -------------------------------------------------------

const vscode = acquireVsCodeApi();
const wrapEl = document.getElementById('canvas-wrap') as HTMLDivElement | null;
const containerEl = document.getElementById('cy') as HTMLDivElement | null;
const emptyEl = document.getElementById('empty') as HTMLDivElement | null;
const refreshBtn = document.getElementById('refresh') as HTMLButtonElement | null;
const ctxMenuEl = document.getElementById('ctx-menu') as HTMLDivElement | null;
const lineageSelect = document.getElementById('lineage-select') as HTMLSelectElement | null;
const newLineageBtn = document.getElementById('new-lineage') as HTMLButtonElement | null;
const iofvPanelEl = document.getElementById('iofv-panel') as HTMLElement | null;
const iofvBodyEl = document.getElementById('iofv-body') as HTMLDivElement | null;
const iofvCloseBtn = document.getElementById('iofv-close') as HTMLButtonElement | null;
const diagnosticsBannerEl = document.getElementById('diagnostics-banner') as HTMLDivElement | null;
if (
  !wrapEl ||
  !containerEl ||
  !emptyEl ||
  !refreshBtn ||
  !ctxMenuEl ||
  !lineageSelect ||
  !newLineageBtn ||
  !iofvPanelEl ||
  !iofvBodyEl ||
  !iofvCloseBtn ||
  !diagnosticsBannerEl
) {
  throw new Error('lineage client: required DOM nodes missing');
}

/** True when the user is viewing a curated named lineage. Drives
 *  context-menu mutation (Add vs Remove "from this lineage"). */
let inCuratedLineage = false;

// ---- Layout config --------------------------------------------------

const NODE_W = 150;
const NODE_H = 76;
/** Horizontal/vertical separation between nodes after d3 layout. */
const NODE_GAP_X = 30;
const NODE_GAP_Y = 50;
const PADDING = 60;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 3;
const ZOOM_FACTOR = 1.1;

// ---- State ----------------------------------------------------------

interface RenderState {
  /** SVG natural width/height in user units (matches layout extent + padding). */
  naturalW: number;
  naturalH: number;
  zoom: number;
  svg: SVGSVGElement;
}
let state: RenderState | null = null;

interface CtxMenuState {
  modelPath: string;
  basename: string;
}
let ctxMenuState: CtxMenuState | null = null;

interface DragState {
  source: { modelPath: string; basename: string; el: SVGGElement; cx: number; cy: number };
  downClientX: number;
  downClientY: number;
  started: boolean;
  ghostLine: SVGLineElement | null;
  dropTarget: SVGGElement | null;
}
/** Drag-to-parent state. Starts on mousedown on a node, becomes a real
 *  drag past `DRAG_THRESHOLD_PX`, ends on mouseup. While `started`, the
 *  pending click on mouseup is suppressed so the user doesn't open the
 *  source's .mod by accident. */
let drag: DragState | null = null;
const DRAG_THRESHOLD_PX = 5;
/** Set briefly true after a drag completes so the pending `click`
 *  event on the source doesn't fire its open-handler. */
let suppressNextClick = false;

// ---- Tree-data shape we feed to d3.hierarchy ------------------------

interface TreeDatum {
  node: LineageNode | null;
  inboundColor: EdgeColor | 'root' | null;
  inboundDelta: number | null;
  /** Mirrors `LineageEdge.viaOverride` for the inbound edge; drives
   *  the dashed-stroke class on the path. */
  inboundViaOverride: boolean;
  isSyntheticRoot: boolean;
  children?: TreeDatum[];
}

// ---- Bootstrap ------------------------------------------------------

// ---- Side-panel ΔiOFV state ----------------------------------------

interface EdgeIOfvRow {
  id: number | string;
  parentIOfv: number;
  childIOfv: number;
  deltaIOfv: number;
}
interface EdgeIOfvSummary {
  n: number;
  totalDelta: number;
  nImproved: number;
  nWorsened: number;
  nIndifferent: number;
  topImproved: EdgeIOfvRow[];
  topWorsened: EdgeIOfvRow[];
}

interface SelectedEdgeState {
  parentModelPath: string;
  childModelPath: string;
  parentBasename: string;
  childBasename: string;
  deltaOfv: number | null;
}
let selectedEdge: SelectedEdgeState | null = null;

window.addEventListener('message', (ev) => {
  const msg = ev.data as
    | {
        type?: string;
        graph?: LineageGraph;
        staleOverrides?: StaleOverride[];
        lineages?: LineageOption[];
        currentLineage?: string;
        // edgeIOfv response
        parentModelPath?: string;
        childModelPath?: string;
        threshold?: number;
        summary?: EdgeIOfvSummary | null;
        incomparableReason?: string | null;
        warning?: string | null;
      }
    | undefined;
  if (!msg) return;
  if (msg.type === 'graph' && msg.graph) {
    // Update the dropdown + curated-mode flag before rendering so the
    // context menu items reflect the right add/remove path.
    if (msg.lineages) populateLineageSelect(msg.lineages, msg.currentLineage ?? '');
    inCuratedLineage = (msg.currentLineage ?? '') !== '';
    updateCtxMenuVisibility();
    renderDiagnosticsBanner(
      msg.graph.unresolvedParentCount ?? 0,
      msg.staleOverrides ?? [],
    );
    // Preserve the side-panel selection across refresh when both
    // endpoints + the edge between them still exist in the new graph.
    // Re-fetches the ΔiOFV (the underlying .phi may have changed if
    // the user re-ran one of the endpoints — this is the iterative-
    // review loop the panel is built for). When the edge is gone
    // (parent override removed, run deleted), drop the selection.
    if (selectedEdge) {
      const freshEdge = msg.graph.edges.find(
        (e) =>
          e.parentModelPath === selectedEdge!.parentModelPath &&
          e.childModelPath === selectedEdge!.childModelPath,
      );
      if (!freshEdge) {
        selectedEdge = null;
        hideIOfvPanel();
      } else {
        selectedEdge.deltaOfv = freshEdge.deltaOfv;
        showIOfvPanelLoading(selectedEdge);
        vscode.postMessage({
          type: 'requestEdgeIOfv',
          parentModelPath: selectedEdge.parentModelPath,
          childModelPath: selectedEdge.childModelPath,
        });
      }
    }
    try {
      render(msg.graph);
    } catch (e) {
      vscode.postMessage({
        type: 'renderError',
        message: e instanceof Error ? (e.stack ?? e.message) : String(e),
      });
    }
    return;
  }
  if (msg.type === 'edgeIOfv') {
    // Stale response (user clicked another edge before this one
    // returned) — ignore. selectedEdge always tracks the freshest click.
    if (
      !selectedEdge ||
      selectedEdge.parentModelPath !== msg.parentModelPath ||
      selectedEdge.childModelPath !== msg.childModelPath
    ) {
      return;
    }
    renderIOfvSummary(
      selectedEdge,
      msg.threshold ?? 3.84,
      msg.summary ?? null,
      msg.incomparableReason ?? null,
      msg.warning ?? null,
    );
  }
});

iofvCloseBtn.addEventListener('click', () => {
  selectedEdge = null;
  hideIOfvPanel();
});

refreshBtn.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
newLineageBtn.addEventListener('click', () => vscode.postMessage({ type: 'newLineage' }));
lineageSelect.addEventListener('change', () => {
  vscode.postMessage({ type: 'selectLineage', lineageName: lineageSelect.value });
});
vscode.postMessage({ type: 'ready' });

function populateLineageSelect(opts: LineageOption[], current: string): void {
  while (lineageSelect!.firstChild) lineageSelect!.removeChild(lineageSelect!.firstChild);
  for (const o of opts) {
    const opt = document.createElement('option');
    opt.value = o.name;
    opt.textContent = o.label;
    if (o.name === current) opt.selected = true;
    lineageSelect!.append(opt);
  }
}

/**
 * Show / hide context-menu items based on the current lineage mode.
 *   - All Runs (`!inCuratedLineage`): "Add to lineage…" so the user
 *     can curate a named subset.
 *   - Curated lineage: "Remove from this lineage" so the user can
 *     prune the curated set in place.
 */
function updateCtxMenuVisibility(): void {
  const addBtn = ctxMenuEl!.querySelector<HTMLButtonElement>('[data-action="addToLineage"]');
  const removeBtn = ctxMenuEl!.querySelector<HTMLButtonElement>('[data-action="removeFromLineage"]');
  if (addBtn) addBtn.hidden = inCuratedLineage;
  if (removeBtn) removeBtn.hidden = !inCuratedLineage;
}

// ---- Context menu helpers ------------------------------------------

function showCtxMenu(clientX: number, clientY: number, s: CtxMenuState): void {
  ctxMenuState = s;
  ctxMenuEl!.hidden = false;
  // Clamp so the menu doesn't spill past the viewport edges.
  const rect = ctxMenuEl!.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 4;
  const maxY = window.innerHeight - rect.height - 4;
  ctxMenuEl!.style.left = `${Math.min(clientX, maxX)}px`;
  ctxMenuEl!.style.top = `${Math.min(clientY, maxY)}px`;
}

function hideCtxMenu(): void {
  ctxMenuEl!.hidden = true;
  ctxMenuState = null;
}

ctxMenuEl.addEventListener('click', (ev) => {
  const target = ev.target;
  if (!(target instanceof HTMLButtonElement) || !ctxMenuState) return;
  const action = target.dataset.action;
  if (
    action === 'open' ||
    action === 'promote' ||
    action === 'setParent' ||
    action === 'createRelation' ||
    action === 'addToLineage' ||
    action === 'removeFromLineage'
  ) {
    vscode.postMessage({
      type: 'nodeAction',
      action,
      modelPath: ctxMenuState.modelPath,
      basename: ctxMenuState.basename,
    });
  }
  hideCtxMenu();
});

document.addEventListener('click', (ev) => {
  if (!ctxMenuEl!.hidden && !ctxMenuEl!.contains(ev.target as Node)) hideCtxMenu();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    hideCtxMenu();
    cancelDrag();
  }
});

// ---- Drag-to-parent --------------------------------------------------

document.addEventListener('mousemove', onDragMove);
document.addEventListener('mouseup', onDragEnd);

function onDragMove(ev: MouseEvent): void {
  if (!drag || !state) return;
  if (!drag.started) {
    const dx = ev.clientX - drag.downClientX;
    const dy = ev.clientY - drag.downClientY;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    // Promote to a real drag: visual cues + ghost line.
    drag.started = true;
    drag.source.el.classList.add('dragging');
    drag.ghostLine = makeGhostLine();
    state.svg.appendChild(drag.ghostLine);
  }
  const pt = clientToSvgPoint(ev.clientX, ev.clientY);
  if (drag.ghostLine) {
    drag.ghostLine.setAttribute('x1', String(drag.source.cx));
    drag.ghostLine.setAttribute('y1', String(drag.source.cy));
    drag.ghostLine.setAttribute('x2', String(pt.x));
    drag.ghostLine.setAttribute('y2', String(pt.y));
  }
  // Update drop target highlight.
  const candidate = findNodeAt(ev.clientX, ev.clientY);
  const newTarget = candidate && candidate !== drag.source.el ? candidate : null;
  if (newTarget !== drag.dropTarget) {
    drag.dropTarget?.classList.remove('drop-target');
    newTarget?.classList.add('drop-target');
    drag.dropTarget = newTarget;
  }
}

function onDragEnd(ev: MouseEvent): void {
  if (!drag) return;
  const wasReal = drag.started;
  const target = drag.dropTarget;
  const sourcePath = drag.source.modelPath;
  const sourceBasename = drag.source.basename;
  cleanupDrag();
  if (!wasReal) return; // pure click, let click handler fire normally
  suppressNextClick = true;
  // Reset shortly after — the click event fires synchronously after
  // mouseup so a microtask delay is enough.
  setTimeout(() => {
    suppressNextClick = false;
  }, 0);
  if (!target) return;
  const targetPath = target.dataset.modelPath;
  if (!targetPath || targetPath === sourcePath) return;
  vscode.postMessage({
    type: 'nodeAction',
    action: 'setParentDirect',
    modelPath: sourcePath,
    parentModelPath: targetPath,
    basename: sourceBasename,
  });
}

function cancelDrag(): void {
  if (!drag) return;
  cleanupDrag();
}

function cleanupDrag(): void {
  if (!drag) return;
  drag.source.el.classList.remove('dragging');
  drag.dropTarget?.classList.remove('drop-target');
  drag.ghostLine?.remove();
  drag = null;
}

function makeGhostLine(): SVGLineElement {
  const ns = 'http://www.w3.org/2000/svg';
  const line = document.createElementNS(ns, 'line');
  line.setAttribute('class', 'drag-ghost');
  return line;
}

/**
 * Convert a client-coords point to SVG model coords. Uses the SVG's
 * screen CTM so it works regardless of zoom (SVG width != viewBox
 * width when zoomed) and scroll offset.
 */
function clientToSvgPoint(clientX: number, clientY: number): { x: number; y: number } {
  if (!state) return { x: 0, y: 0 };
  const pt = state.svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = state.svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const out = pt.matrixTransform(ctm.inverse());
  return { x: out.x, y: out.y };
}

/**
 * Find the `<g class="node">` element at the given client coordinates,
 * if any. Walks up from `elementFromPoint` since the cursor may be
 * over a child of the group (rect, text, tspan).
 */
function findNodeAt(clientX: number, clientY: number): SVGGElement | null {
  const el = document.elementFromPoint(clientX, clientY);
  if (!el) return null;
  let cur: Element | null = el;
  while (cur) {
    if (cur instanceof SVGGElement && cur.classList.contains('node')) return cur;
    cur = cur.parentElement;
  }
  return null;
}
wrapEl.addEventListener('scroll', hideCtxMenu);
// Block native context menu inside the canvas so our custom one is
// the only thing that appears on right-click.
wrapEl.addEventListener('contextmenu', (ev) => ev.preventDefault());

// ---- Wheel handling ------------------------------------------------

// Capture-phase wheel handler so we run BEFORE any handlers attached
// inside the SVG. ctrl/⌘ + wheel zooms; plain wheel scrolls the wrap.
wrapEl.addEventListener(
  'wheel',
  (ev) => {
    ev.preventDefault();
    if (ev.ctrlKey || ev.metaKey) {
      if (!state) return;
      const factor = ev.deltaY > 0 ? 1 / ZOOM_FACTOR : ZOOM_FACTOR;
      const next = clamp(state.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      // Pivot zoom around the cursor: keep the model coord under the
      // cursor stationary so the user feels like they're zooming in
      // on what they're hovering.
      const wrapRect = wrapEl!.getBoundingClientRect();
      const mouseInWrapX = ev.clientX - wrapRect.left;
      const mouseInWrapY = ev.clientY - wrapRect.top;
      const modelX = (wrapEl!.scrollLeft + mouseInWrapX) / state.zoom;
      const modelY = (wrapEl!.scrollTop + mouseInWrapY) / state.zoom;
      applyZoom(next);
      wrapEl!.scrollLeft = modelX * next - mouseInWrapX;
      wrapEl!.scrollTop = modelY * next - mouseInWrapY;
      return;
    }
    // shift + wheel → horizontal scroll. Some browsers auto-route
    // deltaY into deltaX when shift is held; others leave the value
    // in deltaY and use shift purely as an intent signal. Handle both
    // by folding both deltas into the horizontal axis on shift.
    if (ev.shiftKey) {
      wrapEl!.scrollBy({ left: ev.deltaX + ev.deltaY, top: 0 });
    } else {
      wrapEl!.scrollBy({ left: ev.deltaX, top: ev.deltaY });
    }
  },
  { passive: false, capture: true },
);

function applyZoom(z: number): void {
  if (!state) return;
  state.zoom = z;
  state.svg.setAttribute('width', String(state.naturalW * z));
  state.svg.setAttribute('height', String(state.naturalH * z));
}

// ---- Render --------------------------------------------------------

function render(graph: LineageGraph): void {
  hideCtxMenu();
  // Clear prior SVG.
  while (containerEl!.firstChild) containerEl!.removeChild(containerEl!.firstChild);

  if (graph.nodes.length === 0) {
    emptyEl!.style.display = 'block';
    wrapEl!.style.display = 'none';
    state = null;
    return;
  }
  emptyEl!.style.display = 'none';
  wrapEl!.style.display = 'block';

  // Section partitioning: in "All Runs" mode, group root subtrees by
  // their root's dataFile so each `$DATA` source becomes its own
  // visually-banded section. Curated mode renders the user's set as
  // a single section (they've already chosen the runs; further
  // grouping would split their narrative).
  const sections: SectionInput[] = inCuratedLineage
    ? [{ title: '', graph }]
    : partitionByDataset(graph);

  // Lay out each section independently, gather positioned nodes/links + height.
  const laidOut = sections.map((s) => layoutSection(s));

  // Stack sections vertically. Canvas width = max of section widths;
  // section i starts at y = sum of (section heights + SECTION_GAP) above.
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('xmlns', ns);
  svg.style.display = 'block';

  let cursorY = PADDING;
  let canvasW = 0;
  for (const s of laidOut) {
    if (s.title) {
      const header = document.createElementNS(ns, 'text');
      header.setAttribute('class', 'section-header');
      header.setAttribute('x', String(PADDING));
      header.setAttribute('y', String(cursorY + SECTION_HEADER_H * 0.7));
      header.textContent = `${s.title} · ${s.nodeCount} run${s.nodeCount === 1 ? '' : 's'}`;
      svg.appendChild(header);
      // Thin separator line below the header text.
      const rule = document.createElementNS(ns, 'line');
      rule.setAttribute('class', 'section-rule');
      rule.setAttribute('x1', String(PADDING));
      rule.setAttribute('x2', String(s.width - PADDING));
      rule.setAttribute('y1', String(cursorY + SECTION_HEADER_H));
      rule.setAttribute('y2', String(cursorY + SECTION_HEADER_H));
      svg.appendChild(rule);
      cursorY += SECTION_HEADER_H + 8;
    }
    // Translate the section's content by (0, cursorY); also offset the
    // x-axis so each section's leftmost node sits at PADDING.
    const sectionOffsetX = -s.minX + PADDING + NODE_W / 2;
    const sectionOffsetY = cursorY - s.minY + NODE_H / 2;
    drawSection(svg, s, sectionOffsetX, sectionOffsetY);
    canvasW = Math.max(canvasW, s.width);
    cursorY += s.height + SECTION_GAP;
  }
  const canvasH = cursorY - SECTION_GAP + PADDING; // trim the trailing gap
  svg.setAttribute('viewBox', `0 0 ${canvasW} ${canvasH}`);
  svg.setAttribute('width', String(canvasW));
  svg.setAttribute('height', String(canvasH));

  containerEl!.appendChild(svg);
  state = { naturalW: canvasW, naturalH: canvasH, zoom: 1, svg };
}

interface SectionInput {
  /** Empty string = no header (curated single-section mode). */
  title: string;
  graph: LineageGraph;
}

interface LaidOutSection {
  title: string;
  nodeCount: number;
  realNodes: HierarchyPointNode<TreeDatum>[];
  realLinks: {
    source: HierarchyPointNode<TreeDatum>;
    target: HierarchyPointNode<TreeDatum>;
  }[];
  /** Pre-translation min/max in d3-tree coords. */
  minX: number;
  minY: number;
  /** Post-translation footprint (header excluded). */
  width: number;
  height: number;
}

const SECTION_HEADER_H = 22;
const SECTION_GAP = 32;

/**
 * Run d3.tree() + singleton wrap-grid for a section's graph. Returns
 * the positioned nodes/links plus its bounding box so the caller can
 * stack sections vertically.
 */
function layoutSection(input: SectionInput): LaidOutSection {
  const root = buildHierarchy(input.graph);
  const layout = tree<TreeDatum>().nodeSize([NODE_W + NODE_GAP_X, NODE_H + NODE_GAP_Y]);
  layout(root);
  const realNodes: HierarchyPointNode<TreeDatum>[] = [];
  root.each((d) => {
    if (!d.data.isSyntheticRoot) realNodes.push(d as HierarchyPointNode<TreeDatum>);
  });
  const realLinks = root
    .links()
    .filter((l) => !l.source.data.isSyntheticRoot && !l.target.data.isSyntheticRoot) as Array<{
    source: HierarchyPointNode<TreeDatum>;
    target: HierarchyPointNode<TreeDatum>;
  }>;
  // Wrap-grid for singleton roots in any non-curated section (which
  // is, when grouped-by-dataset, every section).
  if (!inCuratedLineage) repositionSingletonsAsGrid(root, realNodes);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of realNodes) {
    minX = Math.min(minX, n.x);
    maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y);
    maxY = Math.max(maxY, n.y);
  }
  return {
    title: input.title,
    nodeCount: realNodes.length,
    realNodes,
    realLinks,
    minX,
    minY,
    width: maxX - minX + NODE_W + PADDING * 2,
    height: maxY - minY + NODE_H + PADDING,
  };
}

/**
 * Emit a section's edges + nodes into the parent SVG with an
 * (offsetX, offsetY) translation so multiple sections stack cleanly.
 */
function drawSection(
  svg: SVGSVGElement,
  s: LaidOutSection,
  offsetX: number,
  offsetY: number,
): void {
  const ns = 'http://www.w3.org/2000/svg';
  const linkGen = linkVertical<
    { source: HierarchyPointNode<TreeDatum>; target: HierarchyPointNode<TreeDatum> },
    HierarchyPointNode<TreeDatum>
  >()
    .source((d) => d.source)
    .target((d) => d.target)
    .x((d) => d.x + offsetX)
    .y((d) => d.y + offsetY);
  for (const link of s.realLinks) {
    const path = document.createElementNS(ns, 'path');
    const dAttr = linkGen(link);
    if (dAttr) path.setAttribute('d', dAttr);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-width', '2');
    const overrideCls = link.target.data.inboundViaOverride ? ' via-override' : '';
    path.setAttribute(
      'class',
      `edge edge-${link.target.data.inboundColor ?? 'gray'}${overrideCls}`,
    );
    const parentNode = link.source.data.node;
    const childNode = link.target.data.node;
    if (parentNode && childNode) {
      path.addEventListener('click', (ev) => {
        ev.stopPropagation();
        onEdgeClick(parentNode, childNode, link.target.data.inboundDelta);
      });
    }
    svg.appendChild(path);
  }
  for (const n of s.realNodes) {
    svg.appendChild(makeNodeGroup(n, offsetX, offsetY));
  }
}

/**
 * Group root subtrees by their root's dataFile. Each unique dataFile
 * becomes its own section. Roots whose `dataFile` is null are
 * collected under `(no dataset)`. Children of a root inherit their
 * parent's section regardless of their own dataFile — keeps the tree
 * visually intact when a child changes datasets (such a change is a
 * meaningful annotation but the tree topology shouldn't fragment).
 */
function partitionByDataset(graph: LineageGraph): SectionInput[] {
  const byPath = new Map(graph.nodes.map((n) => [n.modelPath, n]));
  const childrenOf = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = childrenOf.get(e.parentModelPath) ?? [];
    list.push(e.childModelPath);
    childrenOf.set(e.parentModelPath, list);
  }
  const collectSubtree = (rootPath: string): Set<string> => {
    const seen = new Set<string>([rootPath]);
    const queue = [rootPath];
    while (queue.length) {
      const p = queue.shift()!;
      const kids = childrenOf.get(p);
      if (!kids) continue;
      for (const k of kids) if (!seen.has(k)) {
        seen.add(k);
        queue.push(k);
      }
    }
    return seen;
  };

  // datasetName → { roots[], paths }
  const groups = new Map<string, { roots: string[]; paths: Set<string> }>();
  for (const rp of graph.roots) {
    const root = byPath.get(rp);
    const ds = root?.dataFile ?? '(no dataset)';
    let g = groups.get(ds);
    if (!g) {
      g = { roots: [], paths: new Set() };
      groups.set(ds, g);
    }
    g.roots.push(rp);
    for (const p of collectSubtree(rp)) g.paths.add(p);
  }

  const sections: SectionInput[] = [];
  // Sort sections so the largest dataset (most runs) comes first; ties
  // broken alphabetically for stable rendering.
  const entries = [...groups.entries()].sort(
    (a, b) => b[1].paths.size - a[1].paths.size || a[0].localeCompare(b[0]),
  );
  for (const [dataset, g] of entries) {
    sections.push({
      title: `data: ${dataset}`,
      graph: {
        nodes: graph.nodes.filter((n) => g.paths.has(n.modelPath)),
        edges: graph.edges.filter((e) => g.paths.has(e.childModelPath)),
        roots: g.roots,
      },
    });
  }
  return sections;
}

function makeNodeGroup(
  n: HierarchyPointNode<TreeDatum>,
  offsetX: number,
  offsetY: number,
): SVGGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const node = n.data.node!;
  // Border colour mirrors the inbound edge's ΔOFV class so the node
  // itself signals its relationship to its parent:
  //   green  = ΔOFV improvement   yellow = indifferent
  //   red    = worsening          gray   = noncomparable / no fit
  //   root   = blue (no parent)
  // Termination status surfaces in the hover tooltip — separate
  // signal, not on the node border.
  const colorClass = n.data.inboundColor ?? 'gray';
  const x = n.x + offsetX - NODE_W / 2;
  const y = n.y + offsetY - NODE_H / 2;

  const g = document.createElementNS(ns, 'g');
  g.setAttribute('transform', `translate(${x}, ${y})`);
  g.setAttribute('class', 'node');
  g.dataset.modelPath = node.modelPath;
  g.dataset.basename = node.basename;
  g.style.cursor = 'pointer';

  const rect = document.createElementNS(ns, 'rect');
  rect.setAttribute('width', String(NODE_W));
  rect.setAttribute('height', String(NODE_H));
  rect.setAttribute('rx', '6');
  rect.setAttribute('ry', '6');
  rect.setAttribute('class', `node-rect node-${colorClass}`);
  g.appendChild(rect);

  const text = document.createElementNS(ns, 'text');
  text.setAttribute('class', 'node-text');
  text.setAttribute('x', String(NODE_W / 2));
  text.setAttribute('y', '0');
  text.setAttribute('text-anchor', 'middle');

  const lines = nodeLabelLines(n.data);
  // First tspan needs an explicit y so the line stack starts at the
  // right vertical position; subsequent lines use dy for relative spacing.
  // We center the block vertically in the node by computing the offset
  // from the top of the rect (NODE_H) given the line count and line height.
  const lineHeight = 14;
  const blockHeight = lines.length * lineHeight;
  const firstY = (NODE_H - blockHeight) / 2 + lineHeight - 3; // -3 = baseline fudge
  lines.forEach((line, i) => {
    const tspan = document.createElementNS(ns, 'tspan');
    tspan.setAttribute('x', String(NODE_W / 2));
    if (i === 0) tspan.setAttribute('y', String(firstY));
    else tspan.setAttribute('dy', String(lineHeight));
    tspan.textContent = line;
    text.appendChild(tspan);
  });
  g.appendChild(text);

  // Native title for hover tooltip.
  const title = document.createElementNS(ns, 'title');
  title.textContent = nodeTooltip(n.data);
  g.appendChild(title);

  g.addEventListener('click', () => {
    if (suppressNextClick) return; // pending drag-end suppression
    // Click → activate the Fit Inspector for this run, but keep focus
    // in the lineage view. The extension opens the .lst (Fit Inspector
    // listens to the active editor) with `preserveFocus: true` so the
    // user stays here. .lst is preferred; falls back to .mod when the
    // run hasn't produced a .lst yet.
    vscode.postMessage({
      type: 'open',
      modelPath: node.modelPath,
      lstPath: node.lstPath,
    });
  });
  g.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    showCtxMenu(ev.clientX, ev.clientY, {
      modelPath: node.modelPath,
      basename: node.basename,
    });
  });
  // Drag-to-parent: mousedown starts a candidate drag. Real drag kicks
  // in only past the threshold (so single clicks aren't mistaken for
  // tiny drags). Source is captured here; the document-level mousemove
  // and mouseup handlers progress it.
  g.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return; // left-click only
    drag = {
      source: {
        modelPath: node.modelPath,
        basename: node.basename,
        el: g,
        cx: n.x + offsetX,
        cy: n.y + offsetY,
      },
      downClientX: ev.clientX,
      downClientY: ev.clientY,
      started: false,
      ghostLine: null,
      dropTarget: null,
    };
  });

  return g;
}

// ---- Hierarchy build ----------------------------------------------

function buildHierarchy(graph: LineageGraph): HierarchyPointNode<TreeDatum> {
  const byPath = new Map(graph.nodes.map((n) => [n.modelPath, n]));
  const inboundEdge = new Map<string, LineageEdge>();
  for (const e of graph.edges) inboundEdge.set(e.childModelPath, e);
  const childrenByParent = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = childrenByParent.get(e.parentModelPath) ?? [];
    list.push(e.childModelPath);
    childrenByParent.set(e.parentModelPath, list);
  }
  for (const list of childrenByParent.values()) list.sort();

  function build(modelPath: string): TreeDatum {
    const lineageNode = byPath.get(modelPath)!;
    const edge = inboundEdge.get(modelPath);
    const childPaths = childrenByParent.get(modelPath) ?? [];
    return {
      node: lineageNode,
      inboundColor: edge ? edge.color : 'root',
      inboundDelta: edge?.deltaOfv ?? null,
      inboundViaOverride: edge?.viaOverride ?? false,
      isSyntheticRoot: false,
      children: childPaths.length > 0 ? childPaths.map((p) => build(p)) : undefined,
    };
  }

  // Sort top-level roots by descendant count descending — branchy
  // trees go leftmost, single-node "scratch" roots fall to the right.
  // d3.tree() preserves child order at each level, so children of
  // non-root nodes stay in their `;; Based on:` / path-override
  // declaration order; only the synthetic-root layer reshuffles.
  // Without this, a branched lineage centred among many singletons
  // ends up visually in the middle of the canvas (user's complaint:
  // "I want it to end up at the very left").
  const rootChildren = graph.roots.map((r) => build(r));
  rootChildren.sort((a, b) => countSubtree(b) - countSubtree(a));

  // Synthetic root holds all real roots as children. Keeps d3.tree()
  // happy with a single hierarchy and stays out of the rendered output
  // (filtered via `isSyntheticRoot`).
  const synthetic: TreeDatum = {
    node: null,
    inboundColor: null,
    inboundDelta: null,
    inboundViaOverride: false,
    isSyntheticRoot: true,
    children: rootChildren,
  };

  // d3.hierarchy needs the children accessor; default reads `children`.
  return hierarchy(synthetic) as unknown as HierarchyPointNode<TreeDatum>;
}

// ---- Label / tooltip composition ----------------------------------

function nodeLabelLines(d: TreeDatum): string[] {
  const lines: string[] = [];
  if (d.node) lines.push(d.node.basename);
  // Dataset filename — surfaced inline so the user sees at a glance
  // which `$DATA` each model points at (often the disambiguator
  // between candidate-equivalent runs).
  if (d.node?.dataFile) lines.push(`data: ${d.node.dataFile}`);
  if (d.node && d.node.ofv !== null) lines.push(`OFV = ${formatOfv(d.node.ofv)}`);
  else if (d.node) lines.push('no fit');
  if (d.inboundDelta !== null) {
    const sign = d.inboundDelta > 0 ? '+' : '';
    lines.push(`Δ ${sign}${d.inboundDelta.toFixed(2)}`);
  }
  return lines;
}

function nodeTooltip(d: TreeDatum): string {
  const lines: string[] = [];
  if (!d.node) return '';
  lines.push(d.node.basename);
  // Termination signal appears here (it doesn't drive border colour
  // anymore but it's still useful at-a-glance via hover).
  if (d.node.termination === 'SUCCESSFUL') lines.push('✓ minimization successful');
  else if (d.node.termination === 'TERMINATED') lines.push('✗ minimization terminated');
  else lines.push('· not run / status unknown');
  if (d.node.label) lines.push(`label: ${d.node.label}`);
  if (d.node.description) lines.push(d.node.description);
  lines.push(d.node.modelPath);
  return lines.join('\n');
}

function formatOfv(n: number): string {
  return Number.isFinite(n) ? n.toFixed(3) : String(n);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Diagnostics banner above the legend. Shown only when the workspace
 * has actionable issues — stale `lineageOverrides` entries (path no
 * longer in workspace) or runs whose `;; Based on:` parent ref doesn't
 * resolve in the current view. Hidden when both counts are zero so a
 * clean workspace stays uncluttered. The "Clean N stale" button only
 * surfaces when there's something to clean; unresolved parent links
 * are informational only (the user has to fix them by import or
 * runrecord edit, not a one-click action).
 */
function renderDiagnosticsBanner(
  unresolvedParentCount: number,
  staleOverrides: StaleOverride[],
): void {
  const banner = diagnosticsBannerEl!;
  banner.replaceChildren();
  if (unresolvedParentCount === 0 && staleOverrides.length === 0) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  const parts: string[] = [];
  if (staleOverrides.length > 0) {
    parts.push(
      `${staleOverrides.length} stale override${staleOverrides.length === 1 ? '' : 's'}`,
    );
  }
  if (unresolvedParentCount > 0) {
    parts.push(
      `${unresolvedParentCount} unresolved parent link${unresolvedParentCount === 1 ? '' : 's'}`,
    );
  }
  const text = document.createElement('span');
  text.className = 'diagnostics-text';
  text.textContent = `⚠ ${parts.join(' · ')}`;
  banner.appendChild(text);
  if (staleOverrides.length > 0) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'diagnostics-clean';
    btn.textContent = `Clean ${staleOverrides.length} stale`;
    btn.title = 'Remove lineageOverrides entries pointing at runs no longer in this workspace';
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'cleanStaleOverrides' });
    });
    banner.appendChild(btn);
  }
}

// ---- ΔiOFV side-panel rendering -----------------------------------

function onEdgeClick(
  parent: LineageNode,
  child: LineageNode,
  deltaOfv: number | null,
): void {
  selectedEdge = {
    parentModelPath: parent.modelPath,
    childModelPath: child.modelPath,
    parentBasename: parent.basename,
    childBasename: child.basename,
    deltaOfv,
  };
  showIOfvPanelLoading(selectedEdge);
  vscode.postMessage({
    type: 'requestEdgeIOfv',
    parentModelPath: parent.modelPath,
    childModelPath: child.modelPath,
  });
}

function showIOfvPanelLoading(edge: SelectedEdgeState): void {
  iofvPanelEl!.hidden = false;
  iofvBodyEl!.replaceChildren();
  const heading = document.createElement('div');
  heading.className = 'iofv-summary-line';
  heading.textContent = `${edge.parentBasename} → ${edge.childBasename}`;
  iofvBodyEl!.appendChild(heading);
  if (edge.deltaOfv !== null) {
    const total = document.createElement('div');
    total.className = 'iofv-summary-line';
    const sign = edge.deltaOfv > 0 ? '+' : '';
    total.textContent = `Total ΔOFV (.ext): ${sign}${edge.deltaOfv.toFixed(3)}`;
    iofvBodyEl!.appendChild(total);
  }
  const hint = document.createElement('p');
  hint.className = 'iofv-hint';
  hint.textContent = 'Loading per-subject ΔiOFV…';
  iofvBodyEl!.appendChild(hint);
}

function hideIOfvPanel(): void {
  iofvPanelEl!.hidden = true;
  iofvBodyEl!.replaceChildren();
}

function renderIOfvSummary(
  edge: SelectedEdgeState,
  threshold: number,
  summary: EdgeIOfvSummary | null,
  incomparableReason: string | null,
  warning: string | null,
): void {
  iofvBodyEl!.replaceChildren();

  const heading = document.createElement('div');
  heading.className = 'iofv-summary-line';
  heading.textContent = `${edge.parentBasename} → ${edge.childBasename}`;
  iofvBodyEl!.appendChild(heading);

  if (edge.deltaOfv !== null) {
    const total = document.createElement('div');
    total.className = 'iofv-summary-line';
    const sign = edge.deltaOfv > 0 ? '+' : '';
    total.textContent = `Total ΔOFV (.ext): ${sign}${edge.deltaOfv.toFixed(3)}`;
    iofvBodyEl!.appendChild(total);
  }

  // Incomparable: surface the specific reason as a warning, and a
  // caveat that the .ext ΔOFV above is also not directly interpretable
  // (different mathematical objects on each side).
  if (incomparableReason) {
    const warn = document.createElement('p');
    warn.className = 'iofv-warning';
    warn.textContent = `⚠ Not comparable: ${incomparableReason}`;
    iofvBodyEl!.appendChild(warn);
    const caveat = document.createElement('p');
    caveat.className = 'iofv-hint';
    caveat.textContent =
      'The .ext ΔOFV above is the difference between two different ' +
      'quantities (e.g. fit OFV vs D-optimality criterion) and is not ' +
      'a meaningful improvement / worsening signal here.';
    iofvBodyEl!.appendChild(caveat);
    return;
  }

  if (!summary) {
    const err = document.createElement('p');
    err.className = 'iofv-hint';
    err.textContent =
      'No per-subject ΔiOFV available — .phi missing on one side, ' +
      'or the runs use disjoint subject IDs (different dataset).';
    iofvBodyEl!.appendChild(err);
    return;
  }

  // Soft warning (e.g. method mismatch). Rendered above the tables; the
  // summary is still shown below since the comparison is numerically
  // valid, just methodologically caveated.
  if (warning) {
    const warn = document.createElement('p');
    warn.className = 'iofv-warning iofv-warning-soft';
    warn.textContent = `⚠ ${warning}`;
    iofvBodyEl!.appendChild(warn);
  }

  // Sum-of-iOFV ΔOFV. Should approximate the total .ext ΔOFV when the
  // estimation method's additive constant cancels (same method, same
  // OMEGA structure). When it doesn't cancel, the gap is informative.
  const phiTotal = document.createElement('div');
  phiTotal.className = 'iofv-summary-line';
  const sign = summary.totalDelta > 0 ? '+' : '';
  phiTotal.textContent = `Σ ΔiOFV: ${sign}${summary.totalDelta.toFixed(3)} (n=${summary.n})`;
  iofvBodyEl!.appendChild(phiTotal);

  const counts = document.createElement('div');
  counts.className = 'iofv-counts';
  counts.append(
    badge(`${summary.nImproved} improved`, 'improved'),
    badge(`${summary.nWorsened} worsened`, 'worsened'),
    badge(`${summary.nIndifferent} indifferent`),
  );
  iofvBodyEl!.appendChild(counts);

  const note = document.createElement('p');
  note.className = 'iofv-hint';
  note.textContent =
    `Significance cutoff |ΔiOFV| ≥ ${threshold.toFixed(2)} ` +
    `(χ²₁,0.05; LRT-equivalent per subject).`;
  iofvBodyEl!.appendChild(note);

  if (summary.topImproved.length > 0) {
    iofvBodyEl!.appendChild(sectionTitle('Top improved'));
    iofvBodyEl!.appendChild(buildIOfvTable(summary.topImproved, 'improved'));
  }
  if (summary.topWorsened.length > 0) {
    iofvBodyEl!.appendChild(sectionTitle('Top worsened'));
    iofvBodyEl!.appendChild(buildIOfvTable(summary.topWorsened, 'worsened'));
  }
}

function badge(text: string, kind?: 'improved' | 'worsened'): HTMLElement {
  const el = document.createElement('span');
  el.className = 'iofv-count-badge' + (kind ? ` ${kind}` : '');
  el.textContent = text;
  return el;
}

function sectionTitle(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'iofv-section-title';
  el.textContent = text;
  return el;
}

function buildIOfvTable(
  rows: EdgeIOfvRow[],
  kind: 'improved' | 'worsened',
): HTMLTableElement {
  const table = document.createElement('table');
  table.className = 'iofv-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const h of ['ID', 'parent', 'child', 'Δ']) {
    const th = document.createElement('th');
    th.textContent = h;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.appendChild(td(String(r.id)));
    tr.appendChild(td(formatOfv(r.parentIOfv)));
    tr.appendChild(td(formatOfv(r.childIOfv)));
    const deltaCell = td((r.deltaIOfv > 0 ? '+' : '') + r.deltaIOfv.toFixed(3));
    deltaCell.classList.add(kind === 'improved' ? 'delta-improved' : 'delta-worsened');
    tr.appendChild(deltaCell);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function td(text: string): HTMLTableCellElement {
  const el = document.createElement('td');
  el.textContent = text;
  return el;
}

/**
 * Total node count in a subtree rooted at `d` (1 + every descendant).
 * Used to sort the synthetic-root's top-level children by tree size
 * so branchy lineages anchor at the left of the canvas.
 */
function countSubtree(d: TreeDatum): number {
  if (!d.children || d.children.length === 0) return 1;
  let n = 1;
  for (const c of d.children) n += countSubtree(c);
  return n;
}

const GRID_COLS = 10;

/**
 * Override d3.tree()-assigned positions for singleton top-level roots
 * (children of the synthetic root that have no descendants of their
 * own). Layout: a wrap-grid below the branchy trees.
 *
 *   ┌─────────┐  ┌─────────┐
 *   │run001 ──┼──┤run002   │   <- branchy trees still placed by d3.tree()
 *   └─────────┘  └─────────┘
 *
 *   ┌──┐ ┌──┐ ┌──┐ ┌──┐ ┌──┐    <- singleton grid; up to GRID_COLS
 *   │m1│ │m2│ │m3│ │m4│ │m5│       per row, wraps thereafter
 *   └──┘ └──┘ └──┘ └──┘ └──┘
 *
 * No-op when there are no singletons or no synthetic-root children.
 */
function repositionSingletonsAsGrid(
  root: HierarchyPointNode<TreeDatum>,
  realNodes: HierarchyPointNode<TreeDatum>[],
): void {
  const topRoots = (root.children ?? []) as HierarchyPointNode<TreeDatum>[];
  const singletons = topRoots.filter((r) => !r.children || r.children.length === 0);
  if (singletons.length === 0) return;

  // Find the branchy region's bounding box so the grid sits below it
  // and aligned with its left edge. Branchy descendants are everything
  // in `realNodes` that's NOT one of the singletons.
  const singletonSet = new Set(singletons);
  let branchyBottomY = -Infinity;
  let branchyLeftX = Infinity;
  for (const n of realNodes) {
    if (singletonSet.has(n)) continue;
    branchyBottomY = Math.max(branchyBottomY, n.y);
    branchyLeftX = Math.min(branchyLeftX, n.x);
  }
  const hasBranchy = isFinite(branchyBottomY);
  const startX = hasBranchy ? branchyLeftX : 0;
  const startY = hasBranchy ? branchyBottomY + NODE_H + NODE_GAP_Y * 2 : 0;
  const cellW = NODE_W + NODE_GAP_X;
  const cellH = NODE_H + NODE_GAP_Y;
  singletons.forEach((s, i) => {
    s.x = startX + (i % GRID_COLS) * cellW;
    s.y = startY + Math.floor(i / GRID_COLS) * cellH;
  });
}
