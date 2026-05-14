// Lineage WebView panel — Pirana-style ΔOFV-coloured run-evolution
// tree, opened from the Runs view's toolbar.
//
// The panel HTML is a tiny shell pointing at `media/lineage/style.css`
// + `media/lineage/client.js`; the actual rendering happens DOM-side
// in the client (cytoscape + cytoscape-dagre). Keeps the same bug-class
// barrier we put up after the v0.0.59 incident: no template-literal
// HTML carrying user data, no inline `<script>` block, no `escapeHtml`
// plumbing. Only graph data flows over the message channel.

import * as path from 'node:path';
import * as vscode from 'vscode';
import { errMsg, type Logger } from '../log-utils';
import type { Runner } from '../runner';
import {
  discoverLineage,
  findStaleOverrides,
  readLineageOfvThreshold,
  readNamedLineages,
} from './lineage-discovery';
import { loadEdgeIOfvSummary } from './lineage-edge-iofv';
import type { LineageGraph } from './lineage-graph';
import {
  addToLineage,
  createRelation,
  promoteFromPath,
  removeFromLineage,
  setParent,
  writeLineages,
  writeOverride,
  type RelationActionDeps,
} from './lineage-relation-actions';
import { buildWebviewShell, sanitizeWebviewMessage } from './webview-shell';

/** Special selector value meaning "show every run in the workspace". */
const ALL_RUNS_SELECTION = '';

const PANEL_VIEW_TYPE = 'nonmem.lineage';
const PANEL_TITLE = 'Run Lineage';

export class LineagePanel {
  private static current: LineagePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static showOrFocus(
    extensionUri: vscode.Uri,
    log: Logger,
    runner: Runner,
    showInInspector: (lstPath: string) => Promise<void> | void,
  ): void {
    if (LineagePanel.current) {
      LineagePanel.current.panel.reveal();
      void LineagePanel.current.refresh();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      PANEL_VIEW_TYPE,
      PANEL_TITLE,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
        retainContextWhenHidden: true,
      },
    );
    LineagePanel.current = new LineagePanel(panel, extensionUri, log, runner, showInInspector);
  }

  /**
   * Currently-selected lineage name — empty string means "All Runs"
   * (the workspace-wide auto scan). Set via the dropdown in the panel
   * header; persists for the panel's lifetime.
   */
  private currentLineage = ALL_RUNS_SELECTION;
  /**
   * Most recent graph posted to the webview. Used to resolve `.phi`
   * paths for the lazy `requestEdgeIOfv` handler — the webview only
   * has modelPath identifiers, the host carries the full node payload
   * including phiPath. Refreshed on every `refresh()`. Null until the
   * first refresh completes.
   */
  private lastGraph: LineageGraph | null = null;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly log: Logger,
    private readonly runner: Runner,
    private readonly showInInspector: (lstPath: string) => Promise<void> | void,
  ) {
    this.panel = panel;
    this.panel.webview.html = renderShellHtml(this.panel.webview, extensionUri);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    const named = readNamedLineages();
    try {
      const restrict =
        this.currentLineage && named.has(this.currentLineage)
          ? new Set(named.get(this.currentLineage))
          : undefined;
      const result = await discoverLineage(this.log, restrict);
      this.lastGraph = result.graph;
      void this.panel.webview.postMessage({
        type: 'graph',
        graph: result.graph,
        staleOverrides: result.staleOverrides,
        lineages: this.lineagePickerItems(named),
        currentLineage: this.currentLineage,
      });
    } catch (e) {
      this.log(`lineage-panel: refresh failed: ${errMsg(e)}`);
      this.lastGraph = { nodes: [], edges: [], roots: [], unresolvedParentCount: 0 };
      void this.panel.webview.postMessage({
        type: 'graph',
        graph: this.lastGraph,
        staleOverrides: [],
        lineages: this.lineagePickerItems(named),
        currentLineage: this.currentLineage,
      });
    }
  }

  /**
   * Header dropdown items: `All Runs (workspace)` always first, then
   * each named lineage with its run count. Empty-string value flags
   * the All-Runs entry on the WebView side.
   */
  private lineagePickerItems(named: Map<string, string[]>): { name: string; label: string }[] {
    const items: { name: string; label: string }[] = [
      { name: ALL_RUNS_SELECTION, label: 'All Runs (workspace)' },
    ];
    for (const [name, runs] of named) {
      items.push({ name, label: `${name} (${runs.length} run${runs.length === 1 ? '' : 's'})` });
    }
    return items;
  }

  private async onMessage(msg: unknown): Promise<void> {
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as {
      type?: string;
      action?: string;
      modelPath?: string;
      lstPath?: string | null;
      parentModelPath?: string;
      childModelPath?: string;
      basename?: string;
      lineageName?: string;
      message?: string;
    };
    if (m.type === 'open' && typeof m.modelPath === 'string') {
      await this.activateInspectorForRun(m.modelPath, m.lstPath ?? null);
    } else if (m.type === 'selectLineage' && typeof m.lineageName === 'string') {
      this.currentLineage = m.lineageName;
      void this.refresh();
    } else if (m.type === 'newLineage') {
      await this.newLineage();
    } else if (m.type === 'nodeAction' && typeof m.modelPath === 'string') {
      // Custom HTML context menu in the WebView already showed the
      // options at the cursor; the extension just dispatches the
      // chosen action by name. No QuickPick round trip for the menu
      // itself; `setParent` opens a follow-on picker for the parent
      // choice; `setParentDirect` skips the picker (drag-and-drop
      // already chose both endpoints); `createRelation` does a two-
      // step picker (partner run, then "set as parent" / "as child").
      if (m.action === 'open') return this.openModel(m.modelPath);
      const deps = this.actionDeps();
      if (m.action === 'promote') return promoteFromPath(deps, m.modelPath);
      if (m.action === 'setParent') return setParent(deps, m.modelPath, m.basename ?? '');
      if (m.action === 'createRelation')
        return createRelation(deps, m.modelPath, m.basename ?? '');
      if (m.action === 'setParentDirect' && typeof m.parentModelPath === 'string')
        return writeOverride(deps, m.modelPath, m.parentModelPath, m.basename ?? '');
      if (m.action === 'addToLineage')
        return addToLineage(deps, m.modelPath, m.basename ?? '', (name) => {
          this.currentLineage = name;
        });
      if (m.action === 'removeFromLineage')
        return removeFromLineage(deps, m.modelPath, m.basename ?? '');
    } else if (m.type === 'refresh') {
      void this.refresh();
    } else if (m.type === 'ready') {
      void this.refresh();
    } else if (m.type === 'renderError' && typeof m.message === 'string') {
      this.log(`lineage-panel: client render error: ${sanitizeWebviewMessage(m.message)}`);
    } else if (
      m.type === 'requestEdgeIOfv' &&
      typeof m.parentModelPath === 'string' &&
      typeof m.childModelPath === 'string'
    ) {
      await this.handleEdgeIOfvRequest(m.parentModelPath, m.childModelPath);
    } else if (m.type === 'cleanStaleOverrides') {
      await this.cleanStaleOverrides();
    }
  }

  /**
   * Banner button handler — re-derives stale `lineageOverrides` from
   * the current workspace state (don't trust the webview's snapshot;
   * it could be stale if the user moved files between refreshes),
   * confirms with a modal, then writes back the pruned record. For
   * both `child-missing` and `parent-missing` the entry is removed
   * outright — `parent-missing` can't usefully be repaired automatically
   * (we don't know what the user meant), so falling through to the
   * runrecord `;; Based on:` is the conservative reset.
   */
  private async cleanStaleOverrides(): Promise<void> {
    const config = vscode.workspace.getConfiguration('nonmem');
    const raw = config.get<Record<string, string | null>>('lineageOverrides') ?? {};
    const knownPaths = new Set(this.lastGraph?.nodes.map((n) => n.modelPath) ?? []);
    const stale = findStaleOverrides(new Map(Object.entries(raw)), knownPaths);
    if (stale.length === 0) {
      void vscode.window.showInformationMessage(
        'Positron NONMEM: no stale lineage overrides to clean.',
      );
      return;
    }
    const detail = stale
      .slice(0, 5)
      .map((s) => `• ${path.basename(s.childPath)} (${s.reason})`)
      .join('\n');
    const more = stale.length > 5 ? `\n…and ${stale.length - 5} more` : '';
    const choice = await vscode.window.showWarningMessage(
      `Remove ${stale.length} stale lineage override entr${stale.length === 1 ? 'y' : 'ies'}?`,
      {
        modal: true,
        detail: `These entries point at runs no longer in the workspace:\n${detail}${more}\n\nThe runrecord \`;; Based on:\` markers (if any) will take over.`,
      },
      'Remove',
    );
    if (choice !== 'Remove') return;
    const cleaned: Record<string, string | null> = { ...raw };
    for (const s of stale) delete cleaned[s.childPath];
    try {
      await config.update('lineageOverrides', cleaned, vscode.ConfigurationTarget.Workspace);
      this.log(`lineage-panel: removed ${stale.length} stale override(s)`);
      void this.refresh();
    } catch (e) {
      void vscode.window.showErrorMessage(
        `Positron NONMEM: couldn't update lineageOverrides: ${errMsg(e)}`,
      );
    }
  }

  /**
   * Lazy `.phi` load + ΔiOFV summary computation for an edge clicked in
   * the lineage view. Resolves both endpoints' `phiPath` from the last
   * graph snapshot, reads + parses both `.phi` files, runs
   * `computeEdgeIOfvSummary`, and posts back to the webview. Posts a
   * shaped error message rather than a silent null so the client can
   * distinguish "computing" / "no .phi available" / "ready" states.
   */
  private async handleEdgeIOfvRequest(
    parentModelPath: string,
    childModelPath: string,
  ): Promise<void> {
    const parent = this.lastGraph?.nodes.find((n) => n.modelPath === parentModelPath);
    const child = this.lastGraph?.nodes.find((n) => n.modelPath === childModelPath);
    const threshold = readLineageOfvThreshold();
    const result = await loadEdgeIOfvSummary(
      parent?.phiPath ?? null,
      child?.phiPath ?? null,
      threshold,
      this.log,
    );
    void this.panel.webview.postMessage({
      type: 'edgeIOfv',
      parentModelPath,
      childModelPath,
      threshold,
      summary: result.summary,
      incomparableReason: result.incomparableReason,
      warning: result.warning,
    });
  }

  /**
   * Single-click on a node: activate the Fit Inspector for this run
   * directly — no editor tab opens, focus stays on the lineage viz.
   * Goes through the `showInInspector` callback (wired in extension.ts
   * to `resolveContextForLstUri` + `pushVariables`), bypassing
   * `vscode.window.showTextDocument` entirely. Falls back to opening
   * the `.mod` only when the run has no `.lst` to inspect.
   */
  private async activateInspectorForRun(
    modelPath: string,
    lstPath: string | null,
  ): Promise<void> {
    if (lstPath) {
      try {
        await this.showInInspector(lstPath);
      } catch (e) {
        this.log(`lineage-panel: showInInspector failed for ${path.basename(lstPath)}: ${errMsg(e)}`);
      }
      return;
    }
    // No .lst yet — open the .mod as a real tab so the user has
    // something to look at. (Fit Inspector won't have a fit overlay
    // to show, but the model decls still render.)
    await this.openModel(modelPath);
  }

  /**
   * Right-click → "Open .mod": full-tab open of the model file.
   * Focus shifts to the editor (no `preserveFocus`) since the user
   * explicitly chose to navigate to the source.
   */
  private async openModel(modelPath: string): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(modelPath));
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (e) {
      void vscode.window.showErrorMessage(
        `Failed to open ${path.basename(modelPath)}: ${errMsg(e)}`,
      );
    }
  }

  /**
   * Build a deps snapshot for the action functions in
   * `lineage-relation-actions.ts`. Called at each dispatch so reads of
   * `lastGraph` / `currentLineage` reflect the freshest state.
   */
  private actionDeps(): RelationActionDeps {
    return {
      log: this.log,
      runner: this.runner,
      lastGraph: this.lastGraph,
      currentLineage: this.currentLineage,
      // Snapshot once per dispatch so the three downstream consumers
      // (pickRunFromGraph priorityPaths derivation, addToLineage's
      // existing-set, removeFromLineage's existing-set) all see the
      // same view of `nonmem.lineages` and avoid 2-3 separate
      // `getConfiguration(...).get(...)` round-trips per action.
      namedLineages: readNamedLineages(),
      refresh: () => this.refresh(),
    };
  }

  /**
   * Header `+ New lineage` button: prompt for a name, create an empty
   * curated lineage in `nonmem.lineages`, switch to it.
   */
  private async newLineage(): Promise<void> {
    const existing = readNamedLineages();
    const name = await vscode.window.showInputBox({
      title: 'New Lineage',
      prompt: 'Name for this lineage (a "chapter" of your modeling story)',
      validateInput: (v) => {
        const t = v.trim();
        if (!t) return 'name required';
        if (existing.has(t)) return `lineage "${t}" already exists`;
        return null;
      },
    });
    if (!name) return;
    await writeLineages(new Map(existing).set(name.trim(), []));
    this.currentLineage = name.trim();
    void this.refresh();
  }

  private _disposed = false;
  private dispose(): void {
    // Re-entrancy guard: the panel's onDidDispose handler IS dispose()
    // itself (constructor line 88). The previous body called
    // this.panel.dispose() unconditionally — when triggered via the
    // panel's own onDidDispose, this re-entered the disposal flow.
    // VS Code's panel.dispose() is currently idempotent so no real
    // breakage today, but the pattern was wrong and would bite any
    // future change that made disposal non-idempotent.
    if (this._disposed) return;
    this._disposed = true;
    if (LineagePanel.current === this) LineagePanel.current = undefined;
    // Don't call this.panel.dispose() — either the panel disposed
    // itself (we're being called from onDidDispose) or someone else
    // will (and our disposables include the onDidDispose subscription
    // that would have re-entered us).
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }
}

/**
 * Static shell HTML pointing at the webview-served CSS + JS assets.
 * No user data in here — pure asset URIs and a fixed legend that
 * interpolates the ΔOFV threshold from the graph module so it can't
 * drift if the threshold ever becomes user-configurable.
 *
 * Cytoscape's renderer applies inline styles to its container at
 * runtime — `allowInlineStyle: true` lifts the CSP `style-src` so the
 * canvas paints. Scripts stay strict (`script-src ${cspSource}`).
 */
export function renderShellHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const threshold = readLineageOfvThreshold();
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'lineage', 'style.css'),
  );
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'lineage', 'client.js'),
  );
  const body = `<div class="header">
  <h2>Run Lineage</h2>
  <select id="lineage-select" title="Pick a sub-lineage (chapter), or All Runs to see the full workspace scan."></select>
  <button id="new-lineage" title="Create a new empty sub-lineage and start adding runs to it.">+ New</button>
  <button id="refresh" title="Re-scan workspace for .lst files and the runs that produced them">Refresh</button>
  <span class="nav-hint">scroll to pan · ctrl/⌘+scroll to zoom · drag node onto another to link · right-click for actions</span>
</div>
<div class="legend">
  <span><span class="dot green"></span>ΔOFV ≤ −${threshold} (improvement)</span>
  <span><span class="dot yellow"></span>|ΔOFV| &lt; ${threshold}</span>
  <span><span class="dot red"></span>ΔOFV ≥ +${threshold} (worsening)</span>
  <span><span class="dot gray"></span>noncomparable / no fit</span>
  <span><span class="dot root"></span>root</span>
  <span><span class="dash"></span>workspace override</span>
</div>
<div id="diagnostics-banner" class="diagnostics-banner" hidden></div>
<div class="canvas-row">
  <div id="canvas-wrap">
    <div id="cy"></div>
  </div>
  <aside id="iofv-panel" class="iofv-panel" hidden>
    <header class="iofv-panel-header">
      <span class="iofv-title">ΔiOFV</span>
      <button type="button" id="iofv-close" class="iofv-close" title="Close">×</button>
    </header>
    <div id="iofv-body" class="iofv-body">
      <p class="iofv-hint">Click an edge in the graph to see per-subject ΔiOFV.</p>
    </div>
  </aside>
</div>
<div id="empty">No runs found in this workspace.</div>
<div id="ctx-menu" class="ctx-menu" hidden>
  <button type="button" data-action="open">Open .mod</button>
  <button type="button" data-action="promote">Promote estimates as new child run</button>
  <button type="button" data-action="setParent">Set parent…</button>
  <button type="button" data-action="createRelation">Create relation…</button>
  <button type="button" data-action="addToLineage">Add to lineage…</button>
  <button type="button" data-action="removeFromLineage" hidden>Remove from this lineage</button>
</div>`;
  return buildWebviewShell(webview, {
    styles: [styleUri],
    scripts: [scriptUri],
    body,
    allowInlineStyle: true,
  });
}
