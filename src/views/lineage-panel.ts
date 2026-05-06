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
import { COMMAND } from '../constants';
import { errMsg, type Logger } from '../log-utils';
import type { Runner } from '../runner';
import { computeNextModelName, promoteEstimates } from '../runtime/promote-estimates';
import { scrubPrivate } from '../scrub';
import { discoverLineage } from './lineage-discovery';
import { CHISQ_1DF_05 } from './lineage-graph';

const PANEL_VIEW_TYPE = 'positronNonmem.lineage';
const PANEL_TITLE = 'Run Lineage';

export class LineagePanel {
  private static current: LineagePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static showOrFocus(extensionUri: vscode.Uri, log: Logger, runner: Runner): void {
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
    LineagePanel.current = new LineagePanel(panel, extensionUri, log, runner);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly log: Logger,
    private readonly runner: Runner,
  ) {
    this.panel = panel;
    this.panel.webview.html = renderShellHtml(this.panel.webview, extensionUri);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      const graph = await discoverLineage(this.log);
      void this.panel.webview.postMessage({ type: 'graph', graph });
    } catch (e) {
      this.log(`lineage-panel: refresh failed: ${errMsg(e)}`);
      void this.panel.webview.postMessage({ type: 'graph', graph: { nodes: [], edges: [], roots: [] } });
    }
  }

  private async onMessage(msg: unknown): Promise<void> {
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as {
      type?: string;
      action?: string;
      modelPath?: string;
      basename?: string;
      message?: string;
    };
    if (m.type === 'open' && typeof m.modelPath === 'string') {
      await this.openModel(m.modelPath);
    } else if (m.type === 'nodeAction' && typeof m.modelPath === 'string') {
      // Custom HTML context menu in the WebView already showed the
      // options at the cursor; the extension just dispatches the
      // chosen action by name. No QuickPick round trip.
      if (m.action === 'open') return this.openModel(m.modelPath);
      if (m.action === 'promote') return this.promoteFromPath(m.modelPath);
    } else if (m.type === 'refresh') {
      void this.refresh();
    } else if (m.type === 'ready') {
      void this.refresh();
    } else if (m.type === 'renderError' && typeof m.message === 'string') {
      this.log(`lineage-panel: client render error: ${m.message}`);
    }
  }

  private async openModel(modelPath: string): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(modelPath));
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (e) {
      void vscode.window.showErrorMessage(`Failed to open ${modelPath}: ${errMsg(e)}`);
    }
  }

  /**
   * Promote estimates without an ActiveRun shape — just a model path.
   * Mirrors the body of `extension.ts:promoteEstimatesCommand` so the
   * lineage entry point produces the same result (default name from
   * `computeNextModelName`, name-prompt input box, refresh runs tree
   * on success). Errors are scrubbed before display because PsN's
   * stderr can carry hostnames / user paths.
   */
  private async promoteFromPath(modelPath: string): Promise<void> {
    const defaultPath = computeNextModelName(modelPath);
    const defaultBase = path.basename(defaultPath);
    const newName = await vscode.window.showInputBox({
      title: 'Promote Estimates to New Model',
      prompt: `update_inits will write a new .mod next to ${path.basename(modelPath)}`,
      value: defaultBase,
      valueSelection: [0, defaultBase.length - path.extname(defaultBase).length],
      validateInput: (v) => (v && v.trim() ? null : 'name required'),
    });
    if (!newName) return;
    this.log(`lineage-panel: promote ${modelPath} → ${newName}`);
    try {
      const { outputModelPath } = await promoteEstimates({
        modelPath,
        outputName: newName,
        runner: this.runner,
      });
      this.log(`lineage-panel: wrote ${outputModelPath}`);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(outputModelPath));
      await vscode.window.showTextDocument(doc, { preview: false });
      void vscode.commands.executeCommand(COMMAND.refreshRuns);
      void this.refresh();
    } catch (e) {
      const msg = scrubPrivate(errMsg(e));
      this.log(`lineage-panel: promote failed — ${msg}`);
      void vscode.window.showErrorMessage(`Positron NONMEM: ${msg}`);
    }
  }

  private dispose(): void {
    if (LineagePanel.current === this) LineagePanel.current = undefined;
    this.panel.dispose();
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
 */
export function renderShellHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): string {
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'lineage', 'style.css'),
  );
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'lineage', 'client.js'),
  );
  // Cytoscape's renderer applies inline styles to its container at
  // runtime (cy.css() etc.) — without `'unsafe-inline'` on `style-src`
  // the canvas paints blank and the console logs CSP violations.
  // Scripts stay strict (`script-src ${cspSource}` only) so we still
  // can't be tricked into inlining JS.
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource}`,
  ].join('; ');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${styleUri}">
</head>
<body>
<div class="header">
  <h2>Run Lineage</h2>
  <button id="refresh" title="Re-scan workspace for .lst files and the runs that produced them">Refresh</button>
  <span class="nav-hint">scroll to pan · ctrl/⌘+scroll to zoom · right-click a node for actions</span>
</div>
<div class="legend">
  <span><span class="dot green"></span>ΔOFV ≤ −${CHISQ_1DF_05} (improvement)</span>
  <span><span class="dot yellow"></span>|ΔOFV| &lt; ${CHISQ_1DF_05}</span>
  <span><span class="dot red"></span>ΔOFV ≥ +${CHISQ_1DF_05} (worsening)</span>
  <span><span class="dot gray"></span>noncomparable / no fit</span>
  <span><span class="dot root"></span>root</span>
</div>
<div id="canvas-wrap">
  <div id="cy"></div>
</div>
<div id="empty">No runs found in this workspace.</div>
<div id="ctx-menu" class="ctx-menu" hidden>
  <button type="button" data-action="open">Open .mod</button>
  <button type="button" data-action="promote">Promote estimates as new child run</button>
</div>
<script src="${scriptUri}"></script>
</body>
</html>`;
}
