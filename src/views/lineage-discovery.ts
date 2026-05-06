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
import { findSiblingByExt } from '../fs-utils';
import { errMsg, type Logger } from '../log-utils';
import { loadExtFitForLst } from '../runtime/load-ext-fit';
import { parseRunrecord } from '../runtime/parse-runrecord';
import { extractRunNumber } from '../runtime/promote-estimates';
import {
  buildLineageGraph,
  type LineageGraph,
  type LineageNodeInput,
} from './lineage-graph';

const LST_GLOB = '**/*.lst';
const EXCLUDE_GLOB = '{**/node_modules/**,**/.git/**}';

/** Defensive cap. Workspaces with thousands of fitted runs render
 *  poorly in cytoscape and the disk scans dominate. Truncate to the
 *  500 most-recently-modified runs and log a notice. */
const MAX_NODES = 500;

const NOOP_LOGGER: Logger = () => undefined;

/**
 * Workspace lineage walk. Scans for `.lst` files, resolves each to a
 * sibling `.mod`/`.ctl`, and loads its `LineageNodeInput`. Returns
 * an empty graph when no workspace is open or no `.lst` files exist.
 */
export async function discoverLineage(log: Logger = NOOP_LOGGER): Promise<LineageGraph> {
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
  const filtered = inputs.filter((i): i is LineageNodeInput => i !== null);
  log(`lineage: ${filtered.length} runs included in graph`);
  return buildLineageGraph(filtered);
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

  const lstPath = await findSiblingLst(modelPath);
  const fit = lstPath ? await loadExtFitForLst(lstPath, log) : null;
  const ofv = fit?.ofv ?? null;

  return {
    runNumber,
    modelPath,
    lstPath,
    basename: stem,
    description,
    label,
    ofv,
    basedOn: rr.basedOn,
    computeDeltaOfv: rr.computeDeltaOfv,
  };
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
