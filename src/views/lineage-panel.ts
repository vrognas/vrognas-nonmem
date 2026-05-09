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
import { formatNumberCompact } from '../format-number';
import { parentDirName } from '../fs-utils';
import { errMsg, type Logger } from '../log-utils';
import type { Runner } from '../runner';
import { computeNextModelName, promoteEstimates } from '../runtime/promote-estimates';
import { scrubPrivate } from '../scrub';
import {
  discoverLineage,
  findStaleOverrides,
  readLineageOfvThreshold,
  readNamedLineages,
} from './lineage-discovery';
import { loadEdgeIOfvSummary } from './lineage-edge-iofv';
import { wouldOverrideCreateCycle, type LineageGraph } from './lineage-graph';

/** Special selector value meaning "show every run in the workspace". */
const ALL_RUNS_SELECTION = '';

const PANEL_VIEW_TYPE = 'positronNonmem.lineage';
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
    try {
      const named = readNamedLineages();
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
        lineages: this.lineagePickerItems(readNamedLineages()),
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
      if (m.action === 'promote') return this.promoteFromPath(m.modelPath);
      if (m.action === 'setParent') return this.setParent(m.modelPath, m.basename ?? '');
      if (m.action === 'createRelation') {
        return this.createRelation(m.modelPath, m.basename ?? '');
      }
      if (m.action === 'setParentDirect' && typeof m.parentModelPath === 'string') {
        return this.writeOverride(m.modelPath, m.parentModelPath, m.basename ?? '');
      }
      if (m.action === 'addToLineage') {
        return this.addToLineage(m.modelPath, m.basename ?? '');
      }
      if (m.action === 'removeFromLineage') {
        return this.removeFromLineage(m.modelPath, m.basename ?? '');
      }
    } else if (m.type === 'refresh') {
      void this.refresh();
    } else if (m.type === 'ready') {
      void this.refresh();
    } else if (m.type === 'renderError' && typeof m.message === 'string') {
      this.log(`lineage-panel: client render error: ${m.message}`);
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
        this.log(`lineage-panel: showInInspector failed for ${lstPath}: ${errMsg(e)}`);
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
  /**
   * Right-click → "Set parent…" workflow. Re-runs discovery to get
   * the current node list, presents a QuickPick of every OTHER run
   * (so the user can pick any to be the parent regardless of name —
   * `run<NNN>` and Pirana / hand-rolled names both qualify), and
   * writes the choice to `positronNonmem.lineageOverrides` workspace
   * setting. The picker disambiguates same-basename runs in different
   * folders by showing the parent-dir name in the description and
   * the full path in the detail line.
   *
   * Picking the "(none — make this a root)" entry writes `null` so
   * the override forces the child to be a root regardless of any
   * `;; Based on:` marker in the file.
   */
  private async setParent(childPath: string, childBasename: string): Promise<void> {
    const pick = await pickRunFromGraph(this.log, {
      title: `Set parent of ${childBasename}`,
      placeHolder: 'Pick a parent run (or "none" to make this a root)',
      excludePath: childPath,
      noneOption: {
        label: '$(circle-slash) (none — make this a root)',
        description: 'remove the parent link',
      },
    });
    if (!pick) return;
    await this.writeOverride(childPath, pick.modelPath, childBasename);
  }

  /**
   * "Create relation…" — clicked-driven counterpart to drag-and-drop.
   * Two-step picker: pick a partner run, then choose whether the
   * starting node should be that partner's parent or child. Writes
   * the override via `writeOverride`. Surfaces in the right-click
   * menu so the action is keyboard-navigable (drag isn't).
   */
  private async createRelation(originPath: string, originBasename: string): Promise<void> {
    const partner = await pickRunFromGraph(this.log, {
      title: `Create relation: ${originBasename} ↔ …`,
      placeHolder: 'Pick the other run',
      excludePath: originPath,
    });
    if (!partner || !partner.modelPath) return;
    interface DirectionItem extends vscode.QuickPickItem {
      direction: 'asParent' | 'asChild';
    }
    const directionItems: DirectionItem[] = [
      {
        direction: 'asParent',
        label: `$(arrow-up) Set ${partner.label} as parent of ${originBasename}`,
        description: `${originBasename}.basedOn = ${partner.label}`,
      },
      {
        direction: 'asChild',
        label: `$(arrow-down) Set ${partner.label} as child of ${originBasename}`,
        description: `${partner.label}.basedOn = ${originBasename}`,
      },
    ];
    const directionPick = await vscode.window.showQuickPick(directionItems, {
      title: 'Pick direction',
      placeHolder: 'Which way is the relation?',
    });
    if (!directionPick) return;
    if (directionPick.direction === 'asParent') {
      await this.writeOverride(originPath, partner.modelPath, originBasename);
    } else {
      await this.writeOverride(partner.modelPath, originPath, partner.label);
    }
  }

  /**
   * Write `positronNonmem.lineageOverrides[childPath] = parentPath`
   * (or `null` for "make this a root"). Shared write path for all
   * three relation-edit entry points: `setParent` QuickPick,
   * `createRelation` two-step picker, and drag-to-drop.
   *
   * Pre-flight cycle check: if the proposed override would close a loop
   * with the current edges, refuse the write and toast the user.
   * `buildLineageGraph` would otherwise drop both endpoints to roots
   * (cycle handling), leaving the user with a fragmented tree and no
   * explanation. The check uses `lastGraph` — if we haven't refreshed
   * yet (shouldn't happen after the constructor's first refresh), skip
   * the check rather than block on a missing snapshot.
   */
  private async writeOverride(
    childPath: string,
    parentPath: string | null,
    childBasename: string,
  ): Promise<void> {
    if (
      parentPath !== null &&
      this.lastGraph &&
      wouldOverrideCreateCycle(this.lastGraph.edges, childPath, parentPath)
    ) {
      void vscode.window.showWarningMessage(
        `Positron NONMEM: setting that parent for ${childBasename} would create a cycle in the lineage. No change made.`,
      );
      this.log(
        `lineage-panel: refused cycle-creating override ${childBasename} → ${parentPath}`,
      );
      return;
    }
    const config = vscode.workspace.getConfiguration('nonmem');
    const current = config.get<Record<string, string | null>>('lineageOverrides') ?? {};
    const next: Record<string, string | null> = { ...current };
    next[childPath] = parentPath;
    try {
      await config.update('lineageOverrides', next, vscode.ConfigurationTarget.Workspace);
      this.log(
        `lineage-panel: set parent of ${childBasename} → ${parentPath ?? '(none)'}`,
      );
      void this.refresh();
    } catch (e) {
      void vscode.window.showErrorMessage(
        `Positron NONMEM: couldn't save parent override: ${errMsg(e)}`,
      );
    }
  }

  /**
   * Header `+ New lineage` button: prompt for a name, create an empty
   * curated lineage in `positronNonmem.lineages`, switch to it.
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
    await this.writeLineages(new Map(existing).set(name.trim(), []));
    this.currentLineage = name.trim();
    void this.refresh();
  }

  /**
   * Right-click → "Add to lineage…" — pick (or create) a named
   * lineage and append the run's modelPath to its set. Switches the
   * current view to that lineage so the user sees the result.
   */
  private async addToLineage(modelPath: string, basename: string): Promise<void> {
    const existing = readNamedLineages();
    interface Item extends vscode.QuickPickItem {
      // `kind` collides with VS Code's QuickPickItemKind union type;
      // use `mode` to side-step the structural-type clash.
      mode: 'existing' | 'new';
      name?: string;
    }
    const items: Item[] = [
      ...[...existing.entries()].map(([name, runs]): Item => ({
        mode: 'existing',
        name,
        label: name,
        description: `${runs.length} run${runs.length === 1 ? '' : 's'}`,
        detail: runs.includes(modelPath) ? '(already in this lineage)' : undefined,
      })),
      { mode: 'new', label: '$(add) Create new lineage…' },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: `Add ${basename} to lineage`,
      placeHolder: 'Pick an existing lineage or create a new one',
    });
    if (!pick) return;
    let target: string;
    if (pick.mode === 'new') {
      const name = await vscode.window.showInputBox({
        title: 'New Lineage',
        prompt: `Name for the new lineage (${basename} will be its first run)`,
        validateInput: (v) => {
          const t = v.trim();
          if (!t) return 'name required';
          if (existing.has(t)) return `lineage "${t}" already exists`;
          return null;
        },
      });
      if (!name) return;
      target = name.trim();
    } else {
      target = pick.name!;
    }
    const next = new Map(existing);
    const list = next.get(target) ?? [];
    if (!list.includes(modelPath)) list.push(modelPath);
    next.set(target, list);
    await this.writeLineages(next);
    this.currentLineage = target;
    void this.refresh();
  }

  /** Right-click in a curated lineage → drop this run from it. */
  private async removeFromLineage(modelPath: string, basename: string): Promise<void> {
    if (!this.currentLineage) return;
    const existing = readNamedLineages();
    const list = existing.get(this.currentLineage);
    if (!list) return;
    const next = new Map(existing);
    next.set(this.currentLineage, list.filter((p) => p !== modelPath));
    await this.writeLineages(next);
    this.log(`lineage-panel: removed ${basename} from ${this.currentLineage}`);
    void this.refresh();
  }

  /**
   * Write the named-lineages map back to workspace settings. Map → record
   * conversion preserves insertion order of the dropdown.
   */
  private async writeLineages(map: Map<string, string[]>): Promise<void> {
    const obj: Record<string, string[]> = {};
    for (const [name, runs] of map) obj[name] = runs;
    try {
      await vscode.workspace
        .getConfiguration('nonmem')
        .update('lineages', obj, vscode.ConfigurationTarget.Workspace);
    } catch (e) {
      void vscode.window.showErrorMessage(
        `Positron NONMEM: couldn't save lineages: ${errMsg(e)}`,
      );
    }
  }

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
 * Build the QuickPick item shape used by `Set parent…` /
 * `Create relation…` (and any future picker that lists runs). Shows
 * basename as label, parent-dir + OFV in description (with
 * `formatNumberCompact` so very small / very large OFVs don't lose
 * precision via toFixed), full path as detail. Single helper means
 * all the run-pickers stay visually consistent.
 */
function quickPickItemForRun(
  n: { basename: string; ofv: number | null; modelPath: string },
): vscode.QuickPickItem {
  const dir = parentDirName(n.modelPath);
  const ofvLabel = n.ofv !== null ? `OFV = ${formatNumberCompact(n.ofv)}` : 'no fit';
  return {
    label: n.basename,
    description: dir ? `${dir} · ${ofvLabel}` : ofvLabel,
    detail: n.modelPath,
  };
}

/**
 * Shared QuickPicker for "pick another run from this workspace" — the
 * common shape behind `Set parent…`, `Create relation…`, and any
 * future relation-edit action. Returns the picked item (with `modelPath`
 * either a path or null when the optional `noneOption` was selected),
 * or null when the user dismissed the picker. Shows an info toast
 * instead of an empty picker when there are no other runs AND the
 * caller didn't supply a `noneOption`.
 */
interface PickedRun {
  modelPath: string | null;
  label: string;
}

async function pickRunFromGraph(
  log: (m: string) => void,
  opts: {
    title: string;
    placeHolder: string;
    excludePath: string;
    noneOption?: { label: string; description?: string };
  },
): Promise<PickedRun | null> {
  const { graph } = await discoverLineage(log);
  const others = graph.nodes.filter((n) => n.modelPath !== opts.excludePath);
  if (others.length === 0 && !opts.noneOption) {
    void vscode.window.showInformationMessage(
      'NONMEM: no other runs in this workspace to relate to.',
    );
    return null;
  }
  interface Item extends vscode.QuickPickItem {
    modelPath: string | null;
  }
  const items: Item[] = [];
  if (opts.noneOption) {
    items.push({
      modelPath: null,
      label: opts.noneOption.label,
      description: opts.noneOption.description,
    });
  }
  items.push(
    ...others
      .map((n): Item => ({ modelPath: n.modelPath, ...quickPickItemForRun(n) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  );
  const pick = await vscode.window.showQuickPick(items, {
    title: opts.title,
    placeHolder: opts.placeHolder,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return pick ? { modelPath: pick.modelPath, label: pick.label } : null;
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
  const threshold = readLineageOfvThreshold();
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
</div>
<script src="${scriptUri}"></script>
</body>
</html>`;
}
