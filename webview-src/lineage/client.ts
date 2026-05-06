// Lineage WebView client (Cytoscape renderer).
//
// Loaded by `LineagePanel` via a webview-served bundled script. Receives
// `{ type: 'graph', graph: LineageGraph }` from the extension and
// renders an interactive cytoscape graph with Keizer 2013 colour
// semantics:
//   - node border = parent-edge ΔOFV class (green / red / yellow / gray
//     / blue-for-roots)
//   - edge stroke matches the same class
//   - layout = dagre top-down (parent above, children below)
//
// Click a node → posts `{ type: 'open', modelPath }` to the extension
// (handled in `lineage-panel.ts:onMessage`). Refresh button posts
// `{ type: 'refresh' }`.
//
// Bundled by esbuild from `webview-src/lineage/client.ts` →
// `media/lineage/client.js`. The bundle pulls in cytoscape +
// cytoscape-dagre + dagre.

import cytoscape from 'cytoscape';
// cytoscape-dagre's CJS shape: registering returns void.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import dagre from 'cytoscape-dagre';

cytoscape.use(dagre);

// Wire-format mirror of the extension-side `LineageGraph`. Keep in sync
// with `src/views/lineage-graph.ts`. Duplicated rather than shared
// because the WebView runs in a sandboxed iframe and can't import TS
// modules from the extension.
type EdgeColor = 'green' | 'red' | 'yellow' | 'gray';
interface LineageNode {
  runNumber: number | null;
  modelPath: string;
  lstPath: string | null;
  basename: string;
  description: string | null;
  label: string | null;
  ofv: number | null;
}
interface LineageEdge {
  parentModelPath: string;
  childModelPath: string;
  deltaOfv: number | null;
  color: EdgeColor;
}
interface LineageGraph {
  nodes: LineageNode[];
  edges: LineageEdge[];
  roots: string[];
}

interface VsCodeApi {
  postMessage(msg: unknown): void;
  setState(state: unknown): void;
  getState(): unknown;
}
declare function acquireVsCodeApi(): VsCodeApi;

// Cytoscape's default canvas renderer doesn't resolve CSS custom
// properties (`var(...)`) — it expects literal colour strings. Read
// the resolved values from a probe element at startup, and re-read
// when the user changes themes (handled by re-render after a
// `colorSchemeChange`-style fire from VS Code).
const PROBE_VARS: Record<EdgeColor | 'root' | 'fg' | 'bg', string> = {
  green: '--vscode-charts-green',
  yellow: '--vscode-charts-yellow',
  red: '--vscode-charts-red',
  gray: '--vscode-descriptionForeground',
  root: '--vscode-charts-blue',
  fg: '--vscode-editor-foreground',
  bg: '--vscode-editor-background',
};

function resolveColors(): Record<keyof typeof PROBE_VARS, string> {
  const cs = getComputedStyle(document.body);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(PROBE_VARS)) {
    out[k] = cs.getPropertyValue(v).trim() || '#888';
  }
  return out as Record<keyof typeof PROBE_VARS, string>;
}

const vscode = acquireVsCodeApi();
const containerEl = document.getElementById('cy') as HTMLDivElement | null;
const wrapEl = document.getElementById('canvas-wrap') as HTMLDivElement | null;
const emptyEl = document.getElementById('empty') as HTMLDivElement | null;
const refreshBtn = document.getElementById('refresh') as HTMLButtonElement | null;
const ctxMenuEl = document.getElementById('ctx-menu') as HTMLDivElement | null;
if (!containerEl || !wrapEl || !emptyEl || !refreshBtn || !ctxMenuEl) {
  throw new Error('lineage client: required DOM nodes missing');
}

interface CtxMenuState {
  modelPath: string;
  basename: string;
}
let ctxMenuState: CtxMenuState | null = null;

function showCtxMenu(clientX: number, clientY: number, state: CtxMenuState): void {
  ctxMenuState = state;
  ctxMenuEl!.hidden = false;
  // Position. Clamp inside viewport so the menu doesn't get clipped
  // when right-clicking near the right/bottom edge.
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
  if (action === 'open' || action === 'promote') {
    vscode.postMessage({
      type: 'nodeAction',
      action,
      modelPath: ctxMenuState.modelPath,
      basename: ctxMenuState.basename,
    });
  }
  hideCtxMenu();
});

// Dismiss on outside click / Escape / scroll. Without this the menu
// can hang around after the user navigates elsewhere.
document.addEventListener('click', (ev) => {
  if (!ctxMenuEl!.hidden && !ctxMenuEl!.contains(ev.target as Node)) hideCtxMenu();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') hideCtxMenu();
});
wrapEl.addEventListener('scroll', hideCtxMenu);
// Block the browser's native context menu so our custom one is the
// only thing that appears on right-click within the canvas.
wrapEl.addEventListener('contextmenu', (ev) => ev.preventDefault());

let cy: cytoscape.Core | null = null;

window.addEventListener('message', (ev: MessageEvent) => {
  const msg = ev.data as { type?: string; graph?: LineageGraph } | undefined;
  if (!msg || msg.type !== 'graph' || !msg.graph) return;
  try {
    render(msg.graph);
  } catch (e) {
    vscode.postMessage({
      type: 'renderError',
      message: e instanceof Error ? (e.stack ?? e.message) : String(e),
    });
  }
});

refreshBtn.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

vscode.postMessage({ type: 'ready' });

function render(graph: LineageGraph): void {
  hideCtxMenu();
  if (cy) {
    cy.destroy();
    cy = null;
  }
  if (graph.nodes.length === 0) {
    emptyEl!.style.display = 'block';
    wrapEl!.style.display = 'none';
    return;
  }
  emptyEl!.style.display = 'none';
  wrapEl!.style.display = 'block';

  const colors = resolveColors();

  // Per-node lookups derived from edges: which colour classifies the
  // inbound edge (used for node border) and which ΔOFV to surface in
  // the node label. Roots have neither.
  const nodeKind = new Map<string, EdgeColor | 'root'>();
  const nodeDelta = new Map<string, number | null>();
  for (const r of graph.roots) nodeKind.set(r, 'root');
  for (const e of graph.edges) {
    nodeKind.set(e.childModelPath, e.color);
    nodeDelta.set(e.childModelPath, e.deltaOfv);
  }

  // Stable node IDs come from a path → id table so cytoscape's
  // string-only ID space works with our absolute paths.
  const nodeIdByPath = new Map<string, string>();
  graph.nodes.forEach((n, i) => nodeIdByPath.set(n.modelPath, `n${i}`));

  const elements: cytoscape.ElementDefinition[] = [
    ...graph.nodes.map((n) => {
      const kind = nodeKind.get(n.modelPath) ?? 'gray';
      const inboundDelta = nodeDelta.get(n.modelPath) ?? null;
      return {
        group: 'nodes' as const,
        data: {
          id: nodeIdByPath.get(n.modelPath)!,
          label: nodeLabel(n, inboundDelta),
          basename: n.basename, // single-line, used by tooltip / context menu
          modelPath: n.modelPath,
          ofv: n.ofv,
          description: n.description,
          runLabel: n.label,
          borderColor: colors[kind],
        },
      };
    }),
    ...graph.edges.flatMap((e) => {
      const sourceId = nodeIdByPath.get(e.parentModelPath);
      const targetId = nodeIdByPath.get(e.childModelPath);
      if (!sourceId || !targetId) return [];
      return [
        {
          group: 'edges' as const,
          data: {
            id: `e_${sourceId}_${targetId}`,
            source: sourceId,
            target: targetId,
            edgeColor: colors[e.color],
            deltaOfv: e.deltaOfv,
            // ΔOFV moved onto the child node label; keep edge labels
            // empty so the canvas stays uncluttered when zoomed out.
            deltaLabel: '',
          },
        },
      ];
    }),
  ];

  cy = cytoscape({
    container: containerEl!,
    elements,
    style: stylesheet(colors),
    minZoom: 0.3,
    maxZoom: 3,
    // Disable cytoscape's built-in pan + zoom interactions — the
    // canvas-wrap's native browser scrollbars handle pan, and a
    // custom wheel handler below routes ctrl/⌘-scroll into cy.zoom.
    userPanningEnabled: false,
    userZoomingEnabled: false,
    boxSelectionEnabled: false,
    layout: {
      name: 'dagre',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ rankDir: 'TB', nodeSep: 60, rankSep: 100 } as any),
    },
  });

  cy.on('tap', 'node', (evt) => {
    const modelPath = evt.target.data('modelPath') as string;
    if (modelPath) vscode.postMessage({ type: 'open', modelPath });
  });

  // Right-click → custom HTML context menu at the cursor (replaces
  // the prior QuickPick which surfaced at the command palette). Reads
  // the original mouse coords from the DOM event so the menu lands
  // at the click point regardless of cytoscape's internal coords.
  cy.on('cxttap', 'node', (evt) => {
    const data = evt.target.data();
    const orig = evt.originalEvent as MouseEvent | undefined;
    if (!orig) return;
    showCtxMenu(orig.clientX, orig.clientY, {
      modelPath: data.modelPath as string,
      basename: data.basename as string,
    });
  });

  // Lay out → size canvas to fit graph extent so the scroll wrapper
  // shows scrollbars when the graph is bigger than the visible area.
  // `layoutstop` fires once dagre finishes positioning.
  cy.one('layoutstop', () => sizeCanvasToGraph());

  // Wheel: ctrl/⌘-scroll = zoom (and recompute canvas size so
  // scrollbars track), plain scroll = let the browser pan natively.
  // Bound on wrapEl rather than containerEl so the wrap's overflow
  // sees the un-prevented wheel events.
  wrapEl!.addEventListener(
    'wheel',
    (ev) => {
      if (!cy) return;
      if (!ev.ctrlKey && !ev.metaKey) return; // browser handles pan-scroll
      ev.preventDefault();
      const factor = ev.deltaY > 0 ? 0.9 : 1 / 0.9;
      const next = clamp(cy.zoom() * factor, 0.3, 3);
      // Zoom around the cursor position (cytoscape's renderedPosition
      // is relative to the cy container).
      const rect = containerEl!.getBoundingClientRect();
      cy.zoom({
        level: next,
        renderedPosition: { x: ev.clientX - rect.left, y: ev.clientY - rect.top },
      });
      sizeCanvasToGraph();
    },
    { passive: false },
  );

  // Native browser tooltip: cheap, no extra dep. Updates on mousemove.
  containerEl!.title = '';
  containerEl!.addEventListener('mousemove', (ev) => {
    if (!cy) return;
    let found = '';
    cy.nodes().forEach((el) => {
      const bb = el.renderedBoundingBox();
      if (
        ev.offsetX >= bb.x1 &&
        ev.offsetX <= bb.x2 &&
        ev.offsetY >= bb.y1 &&
        ev.offsetY <= bb.y2
      ) {
        found = nodeTooltip(el.data());
      }
    });
    containerEl!.title = found;
  });
}

/**
 * Resize the cytoscape container to the graph's bounding box at the
 * current zoom level (or to the wrap's visible size, whichever is
 * larger). When the graph is bigger, the wrap shows native browser
 * scrollbars; when it fits, no scrollbars and the canvas just fills
 * the wrap.
 *
 * Re-pans cytoscape to the top-left so scroll(0,0) shows the graph
 * origin — keeps the user's scroll position aligned with what they
 * see on the canvas.
 */
function sizeCanvasToGraph(): void {
  if (!cy || !containerEl || !wrapEl) return;
  const bb = cy.elements().boundingBox();
  const padding = 40;
  const z = cy.zoom();
  const graphW = Math.ceil(bb.w * z + padding * 2);
  const graphH = Math.ceil(bb.h * z + padding * 2);
  const w = Math.max(wrapEl.clientWidth, graphW);
  const h = Math.max(wrapEl.clientHeight, graphH);
  containerEl.style.width = `${w}px`;
  containerEl.style.height = `${h}px`;
  cy.resize();
  // Anchor the graph at (padding, padding) inside the canvas so
  // scrollLeft/scrollTop=0 shows the top-left of the graph.
  cy.pan({ x: -bb.x1 * z + padding, y: -bb.y1 * z + padding });
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function nodeTooltip(d: cytoscape.NodeDataDefinition): string {
  // Tooltip surfaces the long-form metadata that doesn't fit on the
  // node label: run label, description, full path. OFV is on the node
  // itself, not duplicated here.
  const lines: string[] = [d.basename as string];
  if (d.runLabel) lines.push(`label: ${d.runLabel as string}`);
  if (d.description) lines.push(d.description as string);
  if (d.modelPath) lines.push(d.modelPath as string);
  return lines.join('\n');
}

function formatOfv(n: number): string {
  return Number.isFinite(n) ? n.toFixed(3) : String(n);
}

/**
 * Compose the node's display label across (up to) three lines:
 *   line 1 — basename (run001 / m / colistin / …)
 *   line 2 — `OFV = <n>` or `no fit`
 *   line 3 — `Δ <signed n>` (only when this node has a parent edge
 *            with a computed ΔOFV; suppressed for roots and gray edges)
 *
 * Cytoscape's canvas renderer reads `\n` as a hard line break when
 * `text-wrap: 'wrap'` is set on the stylesheet.
 */
function nodeLabel(n: LineageNode, inboundDelta: number | null): string {
  const lines: string[] = [n.basename];
  lines.push(n.ofv !== null ? `OFV = ${formatOfv(n.ofv)}` : 'no fit');
  if (inboundDelta !== null) {
    const sign = inboundDelta > 0 ? '+' : '';
    lines.push(`Δ ${sign}${inboundDelta.toFixed(2)}`);
  }
  return lines.join('\n');
}

// Build the cytoscape stylesheet with resolved colours. Cytoscape's
// canvas renderer doesn't read CSS vars, so the colours come from
// `resolveColors()` and are baked into the stylesheet at render time.
function stylesheet(colors: Record<keyof typeof PROBE_VARS, string>): cytoscape.StylesheetCSS[] {
  return [
    {
      selector: 'node',
      css: {
        label: 'data(label)',
        'text-valign': 'center',
        'text-halign': 'center',
        'text-wrap': 'wrap',
        'text-max-width': '120px',
        'line-height': 1.3,
        'font-size': '11px',
        color: colors.fg,
        'background-color': colors.bg,
        'border-width': 2,
        'border-color': 'data(borderColor)',
        // Explicit sizes — `width: 'label'` was deprecated in
        // cytoscape 3.30. Tuned for the 3-line label
        // ("basename / OFV = N / Δ ±N").
        width: 130,
        height: 60,
        shape: 'round-rectangle',
      } as unknown as cytoscape.Css.Node,
    },
    {
      selector: 'node:selected',
      css: {
        'overlay-color': colors.root,
        'overlay-opacity': 0.15,
      } as unknown as cytoscape.Css.Node,
    },
    {
      selector: 'edge',
      css: {
        width: 2,
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle',
        'target-arrow-color': 'data(edgeColor)',
        'line-color': 'data(edgeColor)',
        label: 'data(deltaLabel)',
        'font-size': '9px',
        color: colors.gray,
        'text-background-color': colors.bg,
        'text-background-opacity': 0.8,
        'text-background-padding': '2px',
      } as unknown as cytoscape.Css.Edge,
    },
  ];
}
