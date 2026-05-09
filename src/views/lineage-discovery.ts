// VS Code-aware lineage loader. Anchors discovery on `.lst` files
// rather than `.mod`/`.ctl` so the lineage view mirrors the Runs pane
// — a "run" exists once it has produced output, and PsN test
// fixtures (`nm_basics/`, `nm_validate/`) without `.lst` are
// automatically excluded. For each `.lst` we resolve the sibling
// `.mod`/`.ctl` and load its runrecord + OFV. Orphan `.lst` files
// without a sibling source are dropped — they can't participate in
// `;; Based on:` linkage and there's nothing to open on click.
//
// Module split:
//   - `loadLineageNodeInput(modelPath, log)` is fs-only and unit-
//     tested with mkdtemp fixtures.
//   - `discoverLineage(log)` is the vscode-aware shell — calls
//     `vscode.workspace.findFiles` for `.lst` then fan-outs.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { findSiblingByExt, parentDirName } from '../fs-utils';
import { errMsg, NOOP_LOGGER, type Logger } from '../log-utils';
import { findArtifactFile } from '../runtime/find-ext-file';
import { loadExtFitForLst } from '../runtime/load-ext-fit';
import { parseLst } from '../runtime/parse-lst';
import { parseRunrecord } from '../runtime/parse-runrecord';
import { extractRunNumber } from '../runtime/promote-estimates';
import {
  buildLineageGraph,
  type LineageGraph,
  type LineageNodeInput,
} from './lineage-graph';

const LST_GLOB = '**/*.lst';
// Skip PsN's internal working directories — `modelfit_dir<N>/NM_run<M>/psn.lst`
// is NONMEM-internal scratch, not a user-facing run. Without this exclusion,
// every fitted run produces a phantom `psn` node in the lineage view.
const EXCLUDE_GLOB =
  '{**/node_modules/**,**/.git/**,**/modelfit_dir*/NM_run*/**,**/NM_run*/**}';

/** Defensive cap. Workspaces with thousands of fitted runs render
 *  poorly in cytoscape and the disk scans dominate. Truncate to the
 *  500 most-recently-modified runs and log a notice. */
const MAX_NODES = 500;

/**
 * One stale `lineageOverrides` setting entry. `reason` says why the
 * entry can't be applied:
 *   - `'child-missing'`  : the child path is no longer in the
 *     workspace (runrecord deleted / renamed). The override is dead
 *     weight regardless of `parentPath`.
 *   - `'parent-missing'` : `parentPath` is non-null but no longer
 *     resolves; the override silently no-ops in `discoverLineage`.
 * Force-root overrides (`parentPath === null`) with a present child
 * are NEVER stale — they're actively suppressing a `;; Based on:`
 * marker.
 */
export interface StaleOverride {
  childPath: string;
  parentPath: string | null;
  reason: 'child-missing' | 'parent-missing';
}

/**
 * Result of a single workspace lineage discovery pass. Wraps the pure
 * graph and the workspace-state diagnostics that the panel surfaces
 * (stale override entries). Pure-graph diagnostics (e.g. unresolved
 * parent count) live on `LineageGraph` itself.
 */
export interface LineageDiscoveryResult {
  graph: LineageGraph;
  staleOverrides: StaleOverride[];
}

/**
 * Pure: classify each `lineageOverrides` entry against the current
 * workspace's known model paths. Returns the stale subset with reason.
 * Used by the panel to surface a "Clean N stale overrides" affordance
 * so the workspace setting doesn't accumulate dead pointers over time.
 */
export function findStaleOverrides(
  overrides: ReadonlyMap<string, string | null>,
  knownPaths: ReadonlySet<string>,
): StaleOverride[] {
  const stale: StaleOverride[] = [];
  for (const [childPath, parentPath] of overrides) {
    if (!knownPaths.has(childPath)) {
      stale.push({ childPath, parentPath, reason: 'child-missing' });
      continue;
    }
    if (parentPath !== null && !knownPaths.has(parentPath)) {
      stale.push({ childPath, parentPath, reason: 'parent-missing' });
    }
  }
  return stale;
}


/**
 * Workspace lineage walk. Scans for `.lst` files, resolves each to a
 * sibling `.mod`/`.ctl`, and loads its `LineageNodeInput`. Returns
 * an empty graph when no workspace is open or no `.lst` files exist.
 *
 * `restrictToModelPaths` (when set) filters the result to a curated
 * set of model paths — used by named sub-lineages
 * (`positronNonmem.lineages` setting) so only the user-included runs
 * appear in the panel. Unset (default) = include every discovered
 * run, capped at `MAX_NODES`.
 */
export async function discoverLineage(
  log: Logger = NOOP_LOGGER,
  restrictToModelPaths?: ReadonlySet<string>,
): Promise<LineageDiscoveryResult> {
  const lstUris = await vscode.workspace.findFiles(LST_GLOB, EXCLUDE_GLOB);
  log(`lineage: scanned ${lstUris.length} .lst files`);

  // Cap before doing per-file work — pick the most-recent N by mtime.
  let candidates = lstUris.map((u) => u.fsPath);
  if (candidates.length > MAX_NODES) {
    const stats = await Promise.all(
      candidates.map(async (p) => ({ p, m: await safeMtimeMs(p) })),
    );
    stats.sort((a, b) => b.m - a.m);
    candidates = stats.slice(0, MAX_NODES).map((s) => s.p);
    log(
      `lineage: truncated to ${MAX_NODES} most-recent .lst files (workspace had ${lstUris.length})`,
    );
  }

  const inputs = await Promise.all(candidates.map((lstPath) => loadFromLst(lstPath, log)));
  let filtered = inputs.filter((i): i is LineageNodeInput => i !== null);
  if (restrictToModelPaths) {
    filtered = filtered.filter((i) => restrictToModelPaths.has(i.modelPath));
    log(`lineage: curated subset → ${filtered.length} runs`);
  }

  // Apply path-based parent overrides from the workspace setting.
  // Lets the user wire ANY two runs together via right-click → Set
  // parent…, persisted in `.vscode/settings.json` (git-trackable).
  // Override entries that don't match a current input are ignored
  // silently — stale entries (parent removed) shouldn't break the view.
  const overrides = readLineageOverrides();
  const buildOpts = { chiSqThreshold: readLineageOfvThreshold() };
  const knownPaths = new Set(filtered.map((i) => i.modelPath));
  const staleOverrides = findStaleOverrides(overrides, knownPaths);
  if (overrides.size > 0) {
    const withOverrides = filtered.map((i) => {
      if (!overrides.has(i.modelPath)) return i;
      const target = overrides.get(i.modelPath)!;
      const basedOnPath = target === null || knownPaths.has(target) ? target : undefined;
      return basedOnPath === undefined ? i : { ...i, basedOnPath };
    });
    log(
      `lineage: applied ${overrides.size} workspace parent override(s)` +
        (staleOverrides.length > 0 ? ` (${staleOverrides.length} stale)` : ''),
    );
    return { graph: buildLineageGraph(withOverrides, buildOpts), staleOverrides };
  }
  log(`lineage: ${filtered.length} runs included in graph`);
  return { graph: buildLineageGraph(filtered, buildOpts), staleOverrides };
}

/**
 * Read `positronNonmem.lineages` workspace setting. Shape:
 *   { "<name>": ["/abs/run001.mod", "/abs/run002.mod", ...] }
 * Empty map when unset.
 */
export function readNamedLineages(): Map<string, string[]> {
  try {
    const raw =
      vscode.workspace.getConfiguration('nonmem').get<Record<string, string[]>>('lineages') ??
      {};
    return new Map(Object.entries(raw));
  } catch {
    return new Map();
  }
}

/**
 * Read the workspace-configurable ΔOFV significance threshold.
 * Defaults to 3.84 (χ²₁,0.05) per Keizer 2013. Setting is a positive
 * number; non-positive values are coerced to the default.
 */
export function readLineageOfvThreshold(): number {
  try {
    const v = vscode.workspace
      .getConfiguration('nonmem')
      .get<number>('lineageOfvThreshold');
    if (typeof v === 'number' && v > 0) return v;
  } catch {
    // fall through
  }
  return 3.84;
}

/**
 * Read `positronNonmem.lineageOverrides` workspace setting. Shape:
 *   { "<absolute-child-mod-path>": "<absolute-parent-mod-path>" | null }
 * Empty map when unset / not in a workspace.
 */
function readLineageOverrides(): Map<string, string | null> {
  try {
    const raw =
      vscode.workspace
        .getConfiguration('nonmem')
        .get<Record<string, string | null>>('lineageOverrides') ?? {};
    return new Map(Object.entries(raw));
  } catch {
    return new Map();
  }
}

async function safeMtimeMs(p: string): Promise<number> {
  try {
    return (await fs.stat(p)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * `.lst → .mod → LineageNodeInput`. Drops `.lst` files without a
 * sibling source (orphan output, model file deleted/renamed) — those
 * can't be opened on click and can't carry runrecord metadata.
 */
async function loadFromLst(lstPath: string, log: Logger): Promise<LineageNodeInput | null> {
  const dir = path.dirname(lstPath);
  const stem = path.basename(lstPath, path.extname(lstPath));
  const modelPath = await findSiblingByExt(dir, stem, ['.mod', '.ctl']);
  if (!modelPath) return null;
  return loadLineageNodeInput(modelPath, log);
}

/**
 * Load a single `.mod` / `.ctl` into a `LineageNodeInput`. The file
 * doesn't need to be `run<NNN>.mod` — Pirana-style `m.mod`,
 * hand-rolled `colistin.mod`, etc. all become nodes. `runNumber` is
 * non-null only for `run<NNN>` names (the runrecord parent linkage
 * still requires numeric IDs); orphans appear as roots with no
 * inbound edges. Returns null only when the file can't be read; all
 * downstream lookups (sibling .lst, .ext, OFV) tolerate failures and
 * degrade to `lstPath: null` / `ofv: null` rather than dropping the
 * node.
 */
export async function loadLineageNodeInput(
  modelPath: string,
  log: Logger = NOOP_LOGGER,
): Promise<LineageNodeInput | null> {
  const runNumber = extractRunNumber(modelPath);
  const stem = path.basename(modelPath, path.extname(modelPath));
  // Display basename = "<parent-dir>/<stem>" so same-named runs in
  // different folders disambiguate visually (e.g. `verbatim/m` vs
  // `card_ss_multi/m` — Improve / Pirana convention). When the model
  // sits at a filesystem root (`/m.mod`, `C:\m.mod`) the parent dir
  // basename is empty, so we degrade to bare stem.
  const parentDir = parentDirName(modelPath);
  const displayBasename = parentDir ? `${parentDir}/${stem}` : stem;

  let modText: string;
  try {
    modText = await fs.readFile(modelPath, 'utf8');
  } catch (e) {
    log(`lineage: read failed for ${modelPath}: ${errMsg(e)}`);
    return null;
  }

  const rr = parseRunrecord(modText);
  const description = rr.tags.get('Description')?.trim() || null;
  const label = rr.tags.get('Label')?.trim() || null;
  const dataFile = extractDataFileBasename(modText);

  const lstPath = await findSiblingLst(modelPath);
  const fit = lstPath ? await loadExtFitForLst(lstPath, log) : null;
  const ofv = fit?.ofv ?? null;
  const phiPath = lstPath ? await findArtifactFile(lstPath, '.phi') : null;
  // Termination status — drives the node's border colour in the
  // lineage view. Read separately from the .ext (which only carries
  // numeric estimates); parseLst surfaces 'SUCCESSFUL' / 'TERMINATED'
  // / 'NOT_TESTED' / null. fs.readFile failure → null. The lineage
  // colours map NOT_TESTED to TERMINATED for now (yellow node) — same
  // visual hierarchy: SUCCESSFUL = green, anything else = warn.
  let termination: 'SUCCESSFUL' | 'TERMINATED' | null = null;
  if (lstPath) {
    try {
      const lstText = await fs.readFile(lstPath, 'utf8');
      const t = parseLst(lstText).termination;
      // Lineage view's termination field is binary today (success/fail
      // styling). Collapse NOT_TESTED → null so it shows as "unknown"
      // rather than a false-positive failure. M11+ may grow a 3-state
      // styling; for now keep the legacy SUCCESSFUL|TERMINATED|null shape.
      termination = t === 'NOT_TESTED' ? null : t;
    } catch (e) {
      log(`lineage: lst parse failed for ${lstPath}: ${errMsg(e)}`);
    }
  }

  return {
    runNumber,
    modelPath,
    lstPath,
    phiPath,
    basename: displayBasename,
    description,
    label,
    ofv,
    termination,
    dataFile,
    basedOn: rr.basedOn,
    computeDeltaOfv: rr.computeDeltaOfv,
  };
}

/**
 * Extract the first non-comment `$DATA <token>` argument from a .mod
 * text and return its basename (so absolute / project-relative paths
 * collapse to a leaf for display). Returns null when no $DATA record.
 *
 * Local regex mirroring `runtime/run-model.ts:resolveDataset` and
 * vscode-nmtran's `parsedModel.dataFile` field. Kept local because the
 * lineage discovery walks hundreds of .mod files; an LSP round-trip
 * via `parseModelFromText` would cost a request per file. If
 * vscode-nmtran ever exposes a bulk-parse RPC, fold this in.
 */
function extractDataFileBasename(modText: string): string | null {
  for (const rawLine of modText.split(/\r?\n/)) {
    const code = rawLine.split(';')[0];
    const m = code.match(/^\s*\$DATA\s+(\S+)/i);
    if (m) return path.basename(m[1]);
  }
  return null;
}

/**
 * Find the sibling `.lst` for a `.mod` / `.ctl`. Returns null when no
 * `.lst` lives next to the model — it just hasn't been run yet.
 */
async function findSiblingLst(modelPath: string): Promise<string | null> {
  const dir = path.dirname(modelPath);
  const stem = path.basename(modelPath, path.extname(modelPath));
  return findSiblingByExt(dir, stem, ['.lst']);
}
