// Relation-edit actions for the Lineage panel — split out of
// `lineage-panel.ts` (was 749 LOC god-module) so the panel itself can
// focus on WebView lifecycle, message routing, and graph-render
// orchestration. These actions all share the same shape: open a
// QuickPick / InputBox, then mutate workspace config and trigger a
// panel refresh.
//
// Functions take a `RelationActionDeps` snapshot so they're free of
// `this` — the panel builds a fresh deps object at each dispatch so
// reads of `lastGraph` / `currentLineage` reflect the current state.

import * as path from 'node:path';
import * as vscode from 'vscode';
import { COMMAND } from '../constants';
import { formatNumberCompact } from '../format-number';
import { parentDirName } from '../fs-utils';
import { errMsg, type Logger } from '../log-utils';
import type { Runner } from '../runner';
import { computeNextModelName, promoteEstimates } from '../runtime/promote-estimates';
import { scrubPrivate } from '../scrub';
import { discoverLineage, readNamedLineages } from './lineage-discovery';
import { wouldOverrideCreateCycle, type LineageGraph } from './lineage-graph';
import { toSettingPath } from './lineage-paths';

export interface RelationActionDeps {
  log: Logger;
  runner: Runner;
  /** Most recent graph snapshot for cycle detection. Null before first refresh. */
  lastGraph: LineageGraph | null;
  /** Currently-active named lineage; the sentinel empty string means "All Runs". */
  currentLineage: string;
  /** Trigger a panel re-render after a state-mutating action. */
  refresh: () => void | Promise<void>;
  /** Switch the panel's active named lineage (called by addToLineage). */
  setCurrentLineage: (name: string) => void;
}

interface PickedRun {
  modelPath: string | null;
  label: string;
}

/**
 * Write `positronNonmem.lineageOverrides[childPath] = parentPath`
 * (or `null` for "make this a root"). Shared write path for all
 * three relation-edit entry points: `setParent` QuickPick,
 * `createRelation` two-step picker, and drag-to-drop.
 *
 * Pre-flight cycle check: if the proposed override would close a loop
 * with the current edges, refuse the write and toast the user.
 */
export async function writeOverride(
  deps: RelationActionDeps,
  childPath: string,
  parentPath: string | null,
  childBasename: string,
): Promise<void> {
  if (
    parentPath !== null &&
    deps.lastGraph &&
    wouldOverrideCreateCycle(deps.lastGraph.edges, childPath, parentPath)
  ) {
    void vscode.window.showWarningMessage(
      `Positron NONMEM: setting that parent for ${childBasename} would create a cycle in the lineage. No change made.`,
    );
    deps.log(
      `lineage-panel: refused cycle-creating override ${childBasename} → ${path.basename(parentPath)}`,
    );
    return;
  }
  const config = vscode.workspace.getConfiguration('nonmem');
  const current = config.get<Record<string, string | null>>('lineageOverrides') ?? {};
  const next: Record<string, string | null> = { ...current };
  // Store workspace-relative when possible so settings.json doesn't leak
  // the absolute /home/<user>/… or remote-FS prefix. Reads handle both
  // forms (see lineage-paths.ts).
  next[toSettingPath(childPath)] = parentPath === null ? null : toSettingPath(parentPath);
  try {
    await config.update('lineageOverrides', next, vscode.ConfigurationTarget.Workspace);
    deps.log(`lineage-panel: set parent of ${childBasename} → ${parentPath ?? '(none)'}`);
    void deps.refresh();
  } catch (e) {
    void vscode.window.showErrorMessage(
      `Positron NONMEM: couldn't save parent override: ${errMsg(e)}`,
    );
  }
}

/** Right-click → "Set parent…" — opens a QuickPick of all other runs. */
export async function setParent(
  deps: RelationActionDeps,
  childPath: string,
  childBasename: string,
): Promise<void> {
  const pick = await pickRunFromGraph(deps.log, {
    title: `Set parent of ${childBasename}`,
    placeHolder: 'Pick a parent run (or "none" to make this a root)',
    excludePath: childPath,
    priorityPaths: priorityPathsForLineage(deps.currentLineage),
    noneOption: {
      label: '$(circle-slash) (none — make this a root)',
      description: 'remove the parent link',
    },
  });
  if (!pick) return;
  await writeOverride(deps, childPath, pick.modelPath, childBasename);
}

/**
 * "Create relation…" — click-driven counterpart to drag-and-drop.
 * Two-step picker: pick a partner run, then choose whether the
 * starting node should be that partner's parent or child.
 */
export async function createRelation(
  deps: RelationActionDeps,
  originPath: string,
  originBasename: string,
): Promise<void> {
  const partner = await pickRunFromGraph(deps.log, {
    title: `Create relation: ${originBasename} ↔ …`,
    placeHolder: 'Pick the other run',
    excludePath: originPath,
    priorityPaths: priorityPathsForLineage(deps.currentLineage),
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
    await writeOverride(deps, originPath, partner.modelPath, originBasename);
  } else {
    await writeOverride(deps, partner.modelPath, originPath, partner.label);
  }
}

/**
 * Right-click → "Add to lineage…" — pick (or create) a named lineage
 * and append the run's modelPath to its set. Switches the panel view
 * to that lineage so the user sees the result.
 */
export async function addToLineage(
  deps: RelationActionDeps,
  modelPath: string,
  basename: string,
): Promise<void> {
  const existing = readNamedLineages();
  interface Item extends vscode.QuickPickItem {
    // `kind` collides with VS Code's QuickPickItemKind union type;
    // use `mode` to side-step the structural-type clash.
    mode: 'existing' | 'new';
    name?: string;
  }
  const items: Item[] = [
    ...[...existing.entries()].map(
      ([name, runs]): Item => ({
        mode: 'existing',
        name,
        label: name,
        description: `${runs.length} run${runs.length === 1 ? '' : 's'}`,
        detail: runs.includes(modelPath) ? '(already in this lineage)' : undefined,
      }),
    ),
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
  await writeLineages(next);
  deps.setCurrentLineage(target);
  void deps.refresh();
}

/** Right-click in a curated lineage → drop this run from it. */
export async function removeFromLineage(
  deps: RelationActionDeps,
  modelPath: string,
  basename: string,
): Promise<void> {
  if (!deps.currentLineage) return;
  const existing = readNamedLineages();
  const list = existing.get(deps.currentLineage);
  if (!list) return;
  const next = new Map(existing);
  next.set(
    deps.currentLineage,
    list.filter((p) => p !== modelPath),
  );
  await writeLineages(next);
  deps.log(`lineage-panel: removed ${basename} from ${deps.currentLineage}`);
  void deps.refresh();
}

/**
 * Write the named-lineages map back to workspace settings. Map → record
 * conversion preserves insertion order of the dropdown. Paths are
 * stored workspace-relative when possible (privacy hygiene — see
 * `lineage-paths.ts`).
 */
export async function writeLineages(map: Map<string, string[]>): Promise<void> {
  const obj: Record<string, string[]> = {};
  for (const [name, runs] of map) obj[name] = runs.map(toSettingPath);
  try {
    await vscode.workspace
      .getConfiguration('nonmem')
      .update('lineages', obj, vscode.ConfigurationTarget.Workspace);
  } catch (e) {
    void vscode.window.showErrorMessage(`Positron NONMEM: couldn't save lineages: ${errMsg(e)}`);
  }
}

/**
 * Right-click → "Promote estimates as new child run". Mirrors
 * extension.ts:promoteEstimatesCommand so the lineage entry point
 * produces the same result (default name from computeNextModelName,
 * name-prompt input box, refresh runs tree on success). Errors are
 * scrubbed before display because PsN stderr can carry hostnames /
 * user paths.
 */
export async function promoteFromPath(
  deps: RelationActionDeps,
  modelPath: string,
): Promise<void> {
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
  deps.log(`lineage-panel: promote ${path.basename(modelPath)} → ${newName}`);
  try {
    const { outputModelPath } = await promoteEstimates({
      modelPath,
      outputName: newName,
      runner: deps.runner,
    });
    deps.log(`lineage-panel: wrote ${path.basename(outputModelPath)}`);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(outputModelPath));
    await vscode.window.showTextDocument(doc, { preview: false });
    void vscode.commands.executeCommand(COMMAND.refreshRuns);
    void deps.refresh();
  } catch (e) {
    const msg = scrubPrivate(errMsg(e));
    deps.log(`lineage-panel: promote failed — ${msg}`);
    void vscode.window.showErrorMessage(`Positron NONMEM: ${msg}`);
  }
}

/**
 * QuickPick item shape used by `setParent` / `createRelation` (and
 * any future picker that lists runs). Shows basename as label,
 * parent-dir + OFV in description (with `formatNumberCompact` so
 * very small / very large OFVs don't lose precision via toFixed),
 * full path as detail. Single helper means all the run-pickers stay
 * visually consistent.
 */
function quickPickItemForRun(n: {
  basename: string;
  ofv: number | null;
  modelPath: string;
}): vscode.QuickPickItem {
  const dir = parentDirName(n.modelPath);
  const ofvLabel = n.ofv !== null ? `OFV = ${formatNumberCompact(n.ofv)}` : 'no fit';
  return {
    label: n.basename,
    description: dir ? `${dir} · ${ofvLabel}` : ofvLabel,
    detail: n.modelPath,
  };
}

/**
 * Resolve the priority-path set for the current curated lineage.
 * Returns `undefined` when no lineage is active (sentinel empty string
 * = "All Runs") — picker shows the flat sorted list in that case.
 * Otherwise returns the set of modelPaths in the named lineage, used
 * by `pickRunFromGraph` to surface them above a Separator before the
 * rest of the workspace.
 */
function priorityPathsForLineage(currentLineage: string): ReadonlySet<string> | undefined {
  if (!currentLineage) return undefined;
  const named = readNamedLineages();
  const paths = named.get(currentLineage);
  return paths ? new Set(paths) : undefined;
}

/**
 * Shared QuickPicker for "pick another run from this workspace" — the
 * common shape behind `setParent`, `createRelation`, and any future
 * relation-edit action. Returns the picked item (with `modelPath`
 * either a path or null when the optional `noneOption` was selected),
 * or null when the user dismissed the picker. Shows an info toast
 * instead of an empty picker when there are no other runs AND the
 * caller didn't supply a `noneOption`.
 *
 * When `priorityPaths` is supplied (the active curated lineage's
 * member set), items in that set appear FIRST, then a `Separator`,
 * then the rest of the workspace — addresses 6th-review L4 by
 * promoting in-lineage runs while keeping cross-lineage edits one
 * extra scroll away rather than gating them behind a mode switch.
 */
async function pickRunFromGraph(
  log: (m: string) => void,
  opts: {
    title: string;
    placeHolder: string;
    excludePath: string;
    noneOption?: { label: string; description?: string };
    priorityPaths?: ReadonlySet<string>;
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
  const sortedItems: Item[] = others
    .map((n): Item => ({ modelPath: n.modelPath, ...quickPickItemForRun(n) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const items: Item[] = [];
  if (opts.noneOption) {
    items.push({
      modelPath: null,
      label: opts.noneOption.label,
      description: opts.noneOption.description,
    });
  }
  if (opts.priorityPaths && opts.priorityPaths.size > 0) {
    const inLineage = sortedItems.filter((it) => opts.priorityPaths!.has(it.modelPath!));
    const outside = sortedItems.filter((it) => !opts.priorityPaths!.has(it.modelPath!));
    if (inLineage.length > 0) {
      items.push({
        modelPath: null,
        label: 'In this lineage',
        kind: vscode.QuickPickItemKind.Separator,
      });
      items.push(...inLineage);
    }
    if (outside.length > 0) {
      items.push({
        modelPath: null,
        label: 'Other workspace runs',
        kind: vscode.QuickPickItemKind.Separator,
      });
      items.push(...outside);
    }
  } else {
    items.push(...sortedItems);
  }
  const pick = await vscode.window.showQuickPick(items, {
    title: opts.title,
    placeHolder: opts.placeHolder,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  // Separators come back as `pick` too but have null `modelPath`. The
  // picker won't actually let the user select a Separator (VS Code
  // skips them), but defensively filter just in case.
  if (!pick || pick.kind === vscode.QuickPickItemKind.Separator) return null;
  return { modelPath: pick.modelPath, label: pick.label };
}
