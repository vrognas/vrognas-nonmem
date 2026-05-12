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
import { findArtifactFile, findExtFile } from '../runtime/find-ext-file';
import { readExtText } from '../runtime/load-ext-text';
import { readXmlText } from '../runtime/load-xml-text';
import { lastCnvTable, type CnvTable } from '../runtime/parse-cnv';
import { lastCorTable, type CorTable } from '../runtime/parse-cor';
import { parseExtFit } from '../runtime/parse-ext-fit';
import { parseExtTrajectory, type ExtTrajectory } from '../runtime/parse-ext-trajectory';
import {
  parseLstCovRecord,
  parseLstEstRecords,
  type RawEstRecord,
} from '../runtime/parse-lst-est-records';
import {
  parseLstTolerances,
  type LstTolerances,
} from '../runtime/parse-lst-tolerances';
import {
  parseEstimationOptions,
  type EstimationOptionsStep,
} from '../runtime/parse-xml-options';
import {
  parseCovarianceOptions,
  type CovarianceOptions,
} from '../runtime/parse-xml-problem-options';
import {
  parseEstimationResults,
  type EstimationStepResult,
} from '../runtime/parse-xml-results';
import type { ExtEstimates } from '../runtime/parse-ext-fit';
import { parseLst, type LstSummary } from '../runtime/parse-lst';
import { extractParameterLabels, type ParameterLabels } from '../runtime/parse-param-labels';
import { parseRunrecord, type RunrecordTags } from '../runtime/parse-runrecord';
import type { SumoSummary } from '../runtime/parse-sumo';
import { readFmsg, type FmsgContent } from '../runtime/read-fmsg';
import { readPrderr, type PrderrContent } from '../runtime/read-prderr';
import { runSumo } from '../runtime/run-sumo';
import { quote } from '../shell';

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
  /** FMSG file contents (NMTRAN parser messages / errors); null when empty or not located. */
  fmsg: FmsgContent | null;
  /**
   * Correlation matrix of estimates from sibling `.cor` (last $EST step).
   * Null when no `.cor` was emitted / read failed / parse returned no
   * tables. Drives the inspector's pairwise-correlation red-flag list.
   */
  cor: CorTable | null;
  /**
   * Convergence-test table from sibling `.cnv` (last $EST step).
   * NM 7.2+, written only when `$EST CTYPE > 0` (EM/MCMC methods).
   * Null when no `.cnv` was emitted (FOCE without CTYPE, parse failed,
   * etc.). Drives the inspector's "EM converged / NOT converged"
   * meta-line verdict.
   */
  cnv: CnvTable | null;
  /**
   * Per-iteration trajectories from sibling `.ext`, one entry per
   * `TABLE NO.` block (chained $EST). Empty when no .ext was found
   * / parse failed. Drives the inspector's convergence-plot section
   * (sparklines per parameter + OFV).
   */
  trajectories: ExtTrajectory[];
  /**
   * Per-`$EST`-step option dictionaries from the sibling `.xml`'s
   * `<nm:estimation_options ... />` elements. The XML is the
   * exhaustive surface for `$EST` settings (the `.lst` echo is a
   * human-readable subset). NM 7.2+ writes `.xml` automatically
   * unless `nmfe76 -xmloff` was used. Empty when no `.xml` was
   * found / parse failed.
   */
  xmlEstimationOptions: EstimationOptionsStep[];
  /**
   * Per-`$EST`-step result fields from `<nm:estimation>` blocks:
   * termination_status (numeric code), burnin_time, elapsed_time.
   * Empty when no `.xml` was found. The `.lst` only echoes per-step
   * timing for the LAST step; XML carries it for every step in the
   * chain.
   */
  xmlEstimationResults: EstimationStepResult[];
  /**
   * `$COVARIANCE` option dictionary from the sibling `.xml`'s
   * `<nm:problem_options>` element's `cov_*` attrs. NM 7.6.0 does NOT
   * emit a dedicated `<nm:covariance_options>` element — empirically
   * confirmed via probes at `~/positron-nonmem/probe-cov*` on the host.
   * Null when no `.xml` was found, no `cov_*` attrs were present
   * (model has no `$COV` record), or parse failed.
   */
  xmlCovarianceOptions: CovarianceOptions | null;
  /**
   * Verbatim user-typed `$EST` records from the `.lst`'s embedded
   * control-stream echo. Index-aligned with `xmlEstimationOptions`
   * (both 1:1 with chained $EST). Carries information XML loses:
   * NOABORT vs NOHABORT (XML conflates), and PRINT/POSTHOC/AUTO/
   * CENTERING/ETABARCHECK/NOSORT (never emitted in XML). Empty when
   * mod-mode (no .lst) or .lst echo couldn't be extracted.
   */
  lstEstRecords: RawEstRecord[];
  /**
   * Runtime-resolved tolerance + sig-digits values from the `.lst`
   * trace blocks (BASE / EST / COV TOLERANCE + SIGL/SIGLO). Used to
   * surface "wire vs runtime" annotations on $EST/$COV options whose
   * XML emit is a sentinel (e.g. `atol='0'` resolves to base ANRD=12).
   * All fields null in mod-mode or for non-ODE models that don't get
   * the trace blocks.
   */
  lstTolerances: LstTolerances;
  /**
   * Verbatim user-typed `$COV` record from the `.lst`'s embedded
   * control-stream echo. NONMEM permits at most one $COV per problem.
   * Used to detect which options the user explicitly typed (vs.
   * inherited / method-default / not-set) for the unified tier
   * classification. Null when mod-mode, no $COV record, or .lst echo
   * couldn't be extracted.
   */
  lstCovRecord: RawEstRecord | null;
  /**
   * Whether the model uses an ODE solver (ADVAN9/13/14/15/16/17/18).
   * Detected via the .lst BASE TOLERANCE block presence — these blocks
   * only emit for ODE-solver runs. Drives the inspector's "is ATOL/TOL
   * applicable" decision: when false, atol/tol rows are hidden unless
   * the user explicitly typed them.
   */
  hasOde: boolean;
  /**
   * Whether the model has a `$LEVEL` record. Used to gate
   * LEVCENTER/LEVOBJTYPE/LEVWT synthesis (these require $LEVEL per
   * Bauer's docs). Derived from a regex scan of the .lst control-stream
   * slice.
   */
  hasLevel: boolean;
  /**
   * Pirana-style `; <label>` comments extracted directly from the
   * control-stream source. Overrides vscode-nmtran's `comment` field
   * which is unreliable (drops `$OMEGA BLOCK(N)` labels entirely;
   * occasional off-by-one on `$THETA`). When both sources are present,
   * the inspector uses ours; when ours doesn't have a label for an
   * index, vscode-nmtran's value is the fallback.
   */
  parameterLabels: ParameterLabels;
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
  log(`activeEditor: ${path.basename(fsPath)} langId=${langId} ext=${ext}`);

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
    log(`mod-mode: vscode-nmtran returned null parsedModel for ${path.basename(uri.fsPath)}`);
    return null;
  }
  log(`mod-mode: parsedModel ok — ${parsedModelStatsLine(model)}`);
  const runrecord = await loadRunrecord(uri.fsPath, log);
  // Extract our own parameter labels from the raw .mod source —
  // defense-in-depth on top of vscode-nmtran's `comment` field. The
  // cache-collision symptoms reported 2026-05-12 are fixed in
  // vscode-nmtran 0.4.22; the override stays as guardrail.
  const parameterLabels = await extractLabelsFromModFile(uri.fsPath, log);
  return { model, modUri: uri, fit: null, sumo: null, lst: null, runrecord, prderr: null, fmsg: null, cor: null, cnv: null, trajectories: [], xmlEstimationOptions: [], xmlEstimationResults: [], xmlCovarianceOptions: null, lstEstRecords: [], lstTolerances: { baseNrd: null, baseAnrd: null, estNrd: null, estAnrd: null, covNrd: null, covAnrd: null, siglo: null, sigl: null }, lstCovRecord: null, hasOde: false, hasLevel: false, parameterLabels };
}

async function extractLabelsFromModFile(
  modPath: string,
  log: VariablesLogger,
): Promise<ParameterLabels> {
  try {
    const text = await fs.readFile(modPath, 'utf8');
    return extractParameterLabels(text);
  } catch (e) {
    log(`mod-mode: label-extract read failed for ${path.basename(modPath)}: ${errMsg(e)}`);
    return { thetas: new Map(), omegas: new Map(), sigmas: new Map() };
  }
}

/**
 * Public entry point used by surfaces other than the active-editor
 * watcher — e.g. clicking a node in the lineage panel triggers
 * Fit Inspector update WITHOUT opening the .lst as an editor (no tab,
 * focus stays on the lineage view). Mirrors the .lst path of
 * `resolveVariablesContext` but takes the URI directly.
 */
export async function resolveContextForLstUri(
  lstUri: vscode.Uri,
  deps: ResolveDeps = {},
): Promise<VariablesContext | null> {
  return resolveLstMode(lstUri, deps.log ?? NOOP_LOGGER, deps.runner);
}

async function resolveLstMode(
  lstUri: vscode.Uri,
  log: VariablesLogger,
  runner: Runner | undefined,
): Promise<VariablesContext | null> {
  const fsPath = lstUri.fsPath;
  log(`lst-mode: resolving for ${path.basename(fsPath)}`);

  // Read the .lst once: drives both the parsed-model (from embedded
  // control stream) and the LstSummary parse. Without it, lst-mode
  // can't proceed.
  let lstText: string;
  try {
    lstText = await fs.readFile(fsPath, 'utf8');
  } catch (e) {
    log(`lst-mode: read failed for ${path.basename(fsPath)}: ${errMsg(e)}`);
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

  // Resolve the modelfit_dir once and share it with every aux-file
  // reader. Previously `loadPrderr` and `loadFmsg` each called
  // `findExtFile(fsPath)` independently — two disk walks per active-
  // editor change for the same answer. Now we walk once.
  const extPath = await findExtFile(fsPath);
  const modelfitDir = extPath ? path.dirname(extPath) : null;

  // Read .ext text once and feed both parsers to avoid two disk
  // roundtrips for the same file (matters on slow remote-mounted FS).
  // Same one-read pattern for `.xml` -- inspector currently only
  // reads `<nm:estimation_options>`, but later parsers will share
  // the text.
  const [extText, xmlText, sumo, lst, runrecord, prderr, fmsg, cor, cnv] = await Promise.all([
    readExtText(fsPath, log),
    readXmlText(fsPath, log, runner),
    loadSumo(fsPath, runner, log),
    loadLstSummaryFromText(lstText, log),
    modUri ? loadRunrecord(modUri.fsPath, log) : loadRunrecordFromText(lstText, log),
    modelfitDir ? loadPrderr(modelfitDir, runner, log) : Promise.resolve(null),
    modelfitDir ? loadFmsg(modelfitDir, runner, log) : Promise.resolve(null),
    loadCor(fsPath, log, runner),
    loadCnv(fsPath, log, runner),
  ]);
  const fit = extText ? parseExtFit(extText) : null;
  const trajectories = extText ? parseExtTrajectory(extText) : [];
  const xmlEstimationOptions = xmlText ? parseEstimationOptions(xmlText) : [];
  const xmlEstimationResults = xmlText ? parseEstimationResults(xmlText) : [];
  const xmlCovarianceOptions = xmlText ? parseCovarianceOptions(xmlText) : null;
  // Verbatim `$EST` echoes from the .lst control-stream slice. Carries
  // user-typed information XML loses (NOABORT vs NOHABORT, PRINT,
  // POSTHOC, etc.). `extractControlStream` returns null when the .lst
  // is malformed or truncated; degrade to empty array.
  const ctrlStream = extractControlStream(lstText);
  const lstEstRecords = ctrlStream ? parseLstEstRecords(ctrlStream) : [];
  const lstCovRecord = ctrlStream ? parseLstCovRecord(ctrlStream) : null;
  // Runtime-resolved tolerance trace from the .lst's BASE/EST/COV
  // TOLERANCE + SIGL/SIGLO blocks. Sparse — fields are null when the
  // corresponding block wasn't emitted (non-ODE model, no $COV, etc.).
  const lstTolerances = parseLstTolerances(lstText);
  // Model-feature flags derived from the control-stream slice.
  // Used by the inspector to gate option-row visibility (ATOL only
  // matters when ODE is used; LEVCENTER/LEVOBJTYPE/LEVWT only with
  // $LEVEL).
  const hasOde = lstTolerances.baseAnrd !== null;
  const hasLevel = ctrlStream ? /^\s*\$LEVEL\b/im.test(ctrlStream) : false;
  // Our own label extraction from the embedded control stream —
  // defense-in-depth on top of vscode-nmtran's `comment` field (the
  // cache-collision bug that motivated this is fixed in vscode-nmtran
  // 0.4.22; the override stays as guardrail).
  const parameterLabels = ctrlStream
    ? extractParameterLabels(ctrlStream)
    : { thetas: new Map(), omegas: new Map(), sigmas: new Map() };
  if (!fit) {
    log(`lst-mode: no .ext / unparseable / no final row — pushing init-only`);
  } else {
    log(
      `lst-mode: fit parsed — finals=${fit.finals.size} ses=${fit.standardErrors.size} ofv=${fit.ofv}`,
    );
  }
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
    fmsg,
    cor,
    cnv,
    trajectories,
    xmlEstimationOptions,
    xmlEstimationResults,
    xmlCovarianceOptions,
    lstEstRecords,
    lstTolerances,
    lstCovRecord,
    hasOde,
    hasLevel,
    parameterLabels,
  };
}

/**
 * Locate the sibling `.cor` and parse its final $EST step's correlation
 * matrix. Two source layouts handled:
 *   - **Plain** `<basename>.cor` (Pirana-flat or PsN-modelfit_dir).
 *   - **Per-file 7z archive** `<basename>.cor.7z` (PsN's default for
 *     COV-step matrices when `-clean` ≥ default — `.cor`, `.cov`, `.coi`
 *     get individually compressed into `<file>.7z` next to plain
 *     `.ext` / `.lst` / `.phi`. Distinct from the `NM_run1.7z` directory
 *     archive that holds PRDERR / FMSG; here it's a single-member
 *     archive with the file at the root.
 *
 * Returns null when the file genuinely isn't there, can't be extracted
 * (no runner), or the parsed text has no `TABLE NO.` block — same
 * degrade-to-null pattern as `loadFit`. NONMEM 7.2+ stores parameter
 * SEs on the matrix diagonal (not 1.0); we preserve verbatim because
 * the red-flag scan is upper-triangle off-diagonal so the diagonal
 * value doesn't matter.
 */
async function loadCor(
  lstPath: string,
  log: VariablesLogger,
  runner: Runner | undefined,
): Promise<CorTable | null> {
  return tryLoad('lst-mode: cor read failed', log, async () => {
    const text = await readArtifactText(lstPath, '.cor', log, runner);
    if (text === null) return null;
    const table = lastCorTable(text);
    if (!table) {
      log(`lst-mode: .cor parsed but no TABLE NO. block recognised`);
      return null;
    }
    log(`lst-mode: cor parsed — ${table.paramNames.length} params, method=${table.method}`);
    return table;
  });
}

/**
 * Convergence-test table loader. NM 7.2+ writes `.cnv` whenever an
 * EM/MCMC `$EST` had `CTYPE > 0`; FOCE-only / CTYPE=0 runs produce
 * none and we degrade to null silently. Mirrors `loadCor` for the
 * plain-vs-`.cnv.7z` fallback (PsN compresses these per-file the
 * same way it does `.cor`).
 */
async function loadCnv(
  lstPath: string,
  log: VariablesLogger,
  runner: Runner | undefined,
): Promise<CnvTable | null> {
  return tryLoad('lst-mode: cnv read failed', log, async () => {
    const text = await readArtifactText(lstPath, '.cnv', log, runner);
    if (text === null) return null;
    const table = lastCnvTable(text);
    if (!table) {
      log(`lst-mode: .cnv parsed but no marker rows recognised`);
      return null;
    }
    log(`lst-mode: cnv parsed — ${table.paramNames.length} cols, method=${table.method}`);
    return table;
  });
}

/**
 * Generic plain-or-7z artifact reader. Used by `.cor` and `.cnv` —
 * both follow the PsN per-file 7z convention (`<basename>.<ext>.7z`,
 * single-member archive with the file at root). Returns null when
 * neither layout has anything readable.
 */
async function readArtifactText(
  lstPath: string,
  extension: `.${string}`,
  log: VariablesLogger,
  runner: Runner | undefined,
): Promise<string | null> {
  const plainPath = await findArtifactFile(lstPath, extension);
  if (plainPath) return fs.readFile(plainPath, 'utf8');

  const archiveExt: `.${string}` = `${extension}.7z`;
  const archivePath = await findArtifactFile(lstPath, archiveExt);
  if (!archivePath) {
    log(`lst-mode: no ${extension} / ${extension}.7z sibling found`);
    return null;
  }
  if (!runner) {
    log(`lst-mode: ${extension}.7z found but no runner — skipping extraction`);
    return null;
  }
  const memberName = path.basename(archivePath, '.7z');
  const cmd = `7z e -so -y ${quote(archivePath)} ${memberName} 2>/dev/null`;
  try {
    const result = await runner.run(cmd, path.dirname(archivePath));
    if (result.code !== 0) {
      log(`lst-mode: 7z extraction returned ${result.code} for ${path.basename(archivePath)}`);
      return null;
    }
    return result.stdout;
  } catch (e) {
    log(`lst-mode: 7z extraction threw for ${path.basename(archivePath)}: ${errMsg(e)}`);
    return null;
  }
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
  modelfitDir: string,
  runner: Runner | undefined,
  log: VariablesLogger,
): Promise<PrderrContent | null> {
  return tryLoad('lst-mode: prderr read failed', log, async () => {
    const result = await readPrderr({ modelfitDir, runner });
    log(
      `lst-mode: prderr ${result ? `found (${result.source}, ${result.content.length} chars)` : '— none'}`,
    );
    return result;
  });
}

async function loadFmsg(
  modelfitDir: string,
  runner: Runner | undefined,
  log: VariablesLogger,
): Promise<FmsgContent | null> {
  return tryLoad('lst-mode: fmsg read failed', log, async () => {
    const result = await readFmsg({ modelfitDir, runner });
    log(
      `lst-mode: fmsg ${result ? `found (${result.source}, ${result.content.length} chars, hasErrors=${result.hasErrors})` : '— none'}`,
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
