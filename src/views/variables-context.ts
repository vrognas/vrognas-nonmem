// Resolve the active editor → declarations + (optional) fit overlay
// snapshot that drives both the Positron Variables pane (init-only)
// and the Fit Inspector WebView (init + final + SE).
//
// Branches on file extension first so a `.lst` whose languageId
// vscode-nmtran has set to `nmtran` still hits the lst-mode path:
//
//   `.lst`           → fit overlay from sibling `.ext` + decls from
//                      sibling `.mod`. URI passed downstream is the
//                      `.mod` URI so view-RPC click-to-source still
//                      jumps to declarations, not into the .lst.
//   `.mod` / `.ctl` → parsedModel from vscode-nmtran; no fit overlay.
//   languageId == nmtran (custom extension) → mod-mode.
//   anything else    → null (Variables pane / Inspector clear).
//
// Logger is injected so the extension's outputChannel binding stays
// in extension.ts and this module remains test-friendly.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { findSiblingByExt } from '../fs-utils';
import {
  getNmtranParsedModel,
  parseNmtranModelFromText,
  type NmtranParsedModel,
} from '../nmtran-client';
import type { Runner } from '../runner';
import { errMsg, tryLoad } from '../log-utils';
import { extractControlStream } from '../runtime/extract-control-stream';
import { findExtFile } from '../runtime/find-ext-file';
import { loadExtFitForLst } from '../runtime/load-ext-fit';
import type { ExtEstimates } from '../runtime/parse-ext-fit';
import { parseLst, type LstSummary } from '../runtime/parse-lst';
import { parseRunrecord, type RunrecordTags } from '../runtime/parse-runrecord';
import type { SumoSummary } from '../runtime/parse-sumo';
import { readPrderr, type PrderrContent } from '../runtime/read-prderr';
import { runSumo } from '../runtime/run-sumo';

export interface VariablesContext {
  /** Parsed-model snapshot pulled from vscode-nmtran for the .mod file. */
  model: NmtranParsedModel;
  /**
   * URI of the .mod (NOT the .lst) so view-RPC click-to-source
   * navigates to decls. Undefined when no sibling .mod was located
   * for an .lst (deleted/renamed source); click-to-source is a no-op
   * in that case rather than jumping into the .lst at a misleading
   * line number.
   */
  modUri?: vscode.Uri;
  /** Absolute path to the active `.lst` (lst-mode); undefined in mod-mode. Used for the inspector summary line. */
  lstPath?: string;
  /** Converged estimates overlay parsed from sibling `.ext`; null when none found. */
  fit: ExtEstimates | null;
  /** sumo-parsed status block + diagnostics for the active .lst; null in mod-mode or when sumo failed. */
  sumo: SumoSummary | null;
  /** `.lst`-direct fields not exposed by sumo (method, sig-digits, …). Null in mod-mode. */
  lst: LstSummary | null;
  /** runrecord `;;` tags from the .mod source. Null when the .mod has none / read failed. */
  runrecord: RunrecordTags | null;
  /** PRDERR file contents (NONMEM warnings); null when none was emitted / not extractable. */
  prderr: PrderrContent | null;
}

/** Logger contract — every diagnostic line about the resolution path goes here. */
export type VariablesLogger = (message: string) => void;

/** Optional dependency injection — pass a Runner to enable sumo lookups in lst-mode. Without it, sumo stays null. */
export interface ResolveDeps {
  log?: VariablesLogger;
  runner?: Runner;
}

const NOOP_LOGGER: VariablesLogger = () => undefined;

export async function resolveVariablesContext(
  editor: vscode.TextEditor,
  deps: ResolveDeps = {},
): Promise<VariablesContext | null> {
  const log = deps.log ?? NOOP_LOGGER;
  const fsPath = editor.document.uri.fsPath;
  const ext = path.extname(fsPath).toLowerCase();
  const langId = editor.document.languageId;
  log(`activeEditor: ${fsPath} langId=${langId} ext=${ext}`);

  if (ext === '.lst') return resolveLstMode(editor.document.uri, log, deps.runner);
  if (ext === '.mod' || ext === '.ctl' || langId === 'nmtran') {
    return resolveModMode(editor.document.uri, log);
  }
  log(`unrecognized editor — clearing variables pane`);
  return null;
}

async function resolveModMode(
  uri: vscode.Uri,
  log: VariablesLogger,
): Promise<VariablesContext | null> {
  const model = await getNmtranParsedModel(uri);
  if (!model) {
    log(`mod-mode: vscode-nmtran returned null parsedModel for ${uri.fsPath}`);
    return null;
  }
  log(`mod-mode: parsedModel ok — ${parsedModelStatsLine(model)}`);
  const runrecord = await loadRunrecord(uri.fsPath, log);
  return { model, modUri: uri, fit: null, sumo: null, lst: null, runrecord, prderr: null };
}

async function resolveLstMode(
  lstUri: vscode.Uri,
  log: VariablesLogger,
  runner: Runner | undefined,
): Promise<VariablesContext | null> {
  const fsPath = lstUri.fsPath;
  log(`lst-mode: resolving for ${fsPath}`);

  // Read the .lst once: drives both the parsed-model (from embedded
  // control stream) and the LstSummary parse. Without it, lst-mode
  // can't proceed.
  let lstText: string;
  try {
    lstText = await fs.readFile(fsPath, 'utf8');
  } catch (e) {
    log(`lst-mode: read failed for ${fsPath}: ${errMsg(e)}`);
    return null;
  }

  // Parse the EMBEDDED control stream, not the current sibling .mod.
  // Rationale: the .mod gets edited as the modeler iterates AFTER a run
  // completes, which leaks forward into past runs' Fit Inspector view.
  // The .lst preserves the as-run control stream verbatim — the right
  // source of truth for a fit-result view.
  const model = await loadParsedModelFromLst(lstText, log);
  if (!model) {
    log(`lst-mode: failed to derive parsedModel from embedded control stream`);
    return null;
  }
  log(`lst-mode: parsedModel ok (from embedded ctrl stream) — ${parsedModelStatsLine(model)}`);

  // Locate the sibling .mod for click-to-source navigation. Walks up
  // one directory level so .lst inside `modelfit_dir<N>/` still finds
  // the parent's .mod. When the .mod can't be located (deleted,
  // renamed) we still render the inspector — clicks just no-op.
  const modUri = await findSiblingModUri(fsPath);
  if (modUri) log(`lst-mode: sibling .mod for navigation = ${modUri.fsPath}`);
  else log(`lst-mode: no sibling .mod found — click-to-source disabled`);

  const [fit, sumo, lst, runrecord, prderr] = await Promise.all([
    loadFit(fsPath, log),
    loadSumo(fsPath, runner, log),
    loadLstSummaryFromText(lstText, log),
    modUri ? loadRunrecord(modUri.fsPath, log) : loadRunrecordFromText(lstText, log),
    loadPrderr(fsPath, runner, log),
  ]);
  return {
    model,
    // No-sibling-mod case: leave `modUri` undefined so the inspector's
    // gotoLine handler no-ops (clicks are a no-op rather than jumping
    // into the .lst at a misleading line number).
    modUri: modUri ?? undefined,
    lstPath: fsPath,
    fit,
    sumo,
    lst,
    runrecord,
    prderr,
  };
}

/**
 * Parse the embedded NM-TRAN control stream out of the .lst text and
 * route it through vscode-nmtran ≥ 0.4.21's `parseModelFromText` API.
 * Falls back to null when either (a) no control stream is found or
 * (b) the API isn't available (older vscode-nmtran installed).
 */
async function loadParsedModelFromLst(
  lstText: string,
  log: VariablesLogger,
): Promise<NmtranParsedModel | null> {
  const ctrl = extractControlStream(lstText);
  if (!ctrl) {
    log(`lst-mode: no $PROBLEM found in .lst — not an NM-TRAN .lst?`);
    return null;
  }
  const model = await parseNmtranModelFromText(ctrl);
  if (!model) {
    log(`lst-mode: parseModelFromText returned null — vscode-nmtran < 0.4.21?`);
    return null;
  }
  return model;
}

async function loadLstSummaryFromText(
  lstText: string,
  log: VariablesLogger,
): Promise<LstSummary | null> {
  return tryLoad('lst-mode: parseLst threw', log, async () => {
    const summary = parseLst(lstText);
    log(
      `lst-mode: lst parsed — method=${summary.methodShort ?? '—'} sigDigits=${summary.sigDigits ?? '—'}`,
    );
    return summary;
  });
}

/**
 * Pull `;; Description:` / `;; Label:` / `;; Based on:` from the .lst's
 * embedded control stream when there's no sibling .mod available
 * (run from a directory where the source has been moved/deleted).
 */
async function loadRunrecordFromText(
  lstText: string,
  log: VariablesLogger,
): Promise<RunrecordTags | null> {
  return tryLoad('runrecord: parse from .lst control stream failed', log, async () => {
    const ctrl = extractControlStream(lstText);
    if (!ctrl) return null;
    const rr = parseRunrecord(ctrl);
    log(`runrecord (from .lst): basedOn=${rr.basedOn ?? '—'} tags=${[...rr.tags.keys()].join(',') || '—'}`);
    return rr;
  });
}

async function loadPrderr(
  lstPath: string,
  runner: Runner | undefined,
  log: VariablesLogger,
): Promise<PrderrContent | null> {
  // PRDERR lives at <modelfitDir>/NM_run1/PRDERR (plain) or inside
  // <modelfitDir>/NM_run1.7z (PsN's default archive). Locate the
  // modelfit_dir via the same cascade we use for .ext.
  const extPath = await findExtFile(lstPath);
  if (!extPath) return null;
  const modelfitDir = path.dirname(extPath);
  return tryLoad('lst-mode: prderr read failed', log, async () => {
    const result = await readPrderr({ modelfitDir, runner });
    log(
      `lst-mode: prderr ${result ? `found (${result.source}, ${result.content.length} chars)` : '— none'}`,
    );
    return result;
  });
}

async function loadRunrecord(modPath: string, log: VariablesLogger): Promise<RunrecordTags | null> {
  return tryLoad('runrecord: failed to read .mod for tags', log, async () => {
    const text = await fs.readFile(modPath, 'utf8');
    const rr = parseRunrecord(text);
    log(`runrecord: basedOn=${rr.basedOn ?? '—'} tags=${[...rr.tags.keys()].join(',') || '—'}`);
    return rr;
  });
}

async function loadSumo(
  lstPath: string,
  runner: Runner | undefined,
  log: VariablesLogger,
): Promise<SumoSummary | null> {
  if (!runner) return null;
  return tryLoad('lst-mode: sumo invocation failed', log, async () => {
    const summary = await runSumo({ lstPath, runner });
    if (!summary) {
      log(`lst-mode: sumo returned no parseable output (RC≠0 or unrecognised text)`);
      return null;
    }
    log(`lst-mode: sumo parsed — statuses=${summary.statuses.length} ofv=${summary.ofv}`);
    return summary;
  });
}

async function loadFit(lstPath: string, log: VariablesLogger): Promise<ExtEstimates | null> {
  const fit = await loadExtFitForLst(lstPath, log);
  if (!fit) {
    log(`lst-mode: no .ext / unparseable / no final row — pushing init-only`);
  } else {
    log(
      `lst-mode: fit parsed — finals=${fit.finals.size} ses=${fit.standardErrors.size} ofv=${fit.ofv}`,
    );
  }
  return fit;
}

/**
 * Locate the sibling `.mod` / `.ctl` for a given `.lst`. Search order:
 *
 *   1. Same directory (Pirana / nmfe-direct).
 *   2. Parent directory. Catches the PsN layout where the .lst gets
 *      copied back into `<workspace>/modelfit_dir<N>/run001.lst`
 *      while the source .mod stays at `<workspace>/run001.mod`.
 *
 * Returns null when neither layout has a sibling — e.g. the .mod got
 * deleted/renamed since the run. Caller still renders the inspector;
 * click-to-source becomes a no-op.
 */
async function findSiblingModUri(lstPath: string): Promise<vscode.Uri | null> {
  const dir = path.dirname(lstPath);
  const stem = path.basename(lstPath, path.extname(lstPath));
  const exts = ['.mod', '.ctl'];
  const sameDir = await findSiblingByExt(dir, stem, exts);
  if (sameDir) return vscode.Uri.file(sameDir);
  const parent = path.dirname(dir);
  if (parent && parent !== dir) {
    const parentMatch = await findSiblingByExt(parent, stem, exts);
    if (parentMatch) return vscode.Uri.file(parentMatch);
  }
  return null;
}

/** One-liner shape for "parsedModel ok" log lines so mod-mode and lst-mode stay in sync. */
function parsedModelStatsLine(model: NmtranParsedModel): string {
  return `thetas=${model.thetas.length} omegas=${model.omegas.length} sigmas=${model.sigmas.length} eqs=${model.equations.length}`;
}
