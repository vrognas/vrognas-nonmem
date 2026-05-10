import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { COMMAND, DEFAULT_EXECUTE_BINARY, OUTPUT_CHANNEL_NAME, VIEW_ID } from './constants';
import { getNmtranParsedModel } from './nmtran-client';
import { errMsg } from './log-utils';
import { getPositron, PositronApiUnavailableError } from './positron-api';
import { fetchNmVersions, type NmVersionEntry } from './psn-conf';
import { LocalRunner } from './runner';
import { scrubPrivate } from './scrub';
import { findLatestModelfitDir, runModel } from './runtime/run-model';
import { computeNextModelName, promoteEstimates } from './runtime/promote-estimates';
import { countEstimationRecords } from './runtime/count-estimation-records';
import { sendSignal, type SignalName } from './runtime/signal-dispatch';
import {
  resolveContextForLstUri,
  resolveVariablesContext,
  type VariablesContext,
} from './views/variables-context';
import { ActiveRunsWatcher } from './runtime/active-runs-watcher';
import { NonmemRuntimeManager } from './runtime/runtime-manager';
import {
  ActiveRunsTracker,
  chooseRunAction,
  reconcileCompletion,
  reconcileFailure,
  type ActiveRun,
} from './runtime/active-runs-tracker';
import { ActiveRunsTreeProvider } from './views/active-runs-tree-provider';
import { discoverRuns } from './views/runs-discovery';
import { RunsTreeProvider } from './views/runs-tree-provider';
import { FitInspectorProvider } from './views/fit-inspector-provider';
import { buildInspectorPayload } from './views/fit-inspector-payload';
import { LineagePanel } from './views/lineage-panel';
import { LstFileDecorationProvider } from './views/lst-decoration-provider';

let outputChannel: vscode.OutputChannel | undefined;
let runtimeManager: NonmemRuntimeManager | undefined;
let fitInspector: FitInspectorProvider | undefined;
const runner = new LocalRunner();
const activeRunsTracker = new ActiveRunsTracker();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(outputChannel);

  context.subscriptions.push(vscode.commands.registerCommand(COMMAND.runModel, runCurrentModel));
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND.showNmtranParsedModel, showNmtranParsedModel),
  );
  context.subscriptions.push(vscode.commands.registerCommand(COMMAND.openRun, openRun));
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND.promoteEstimates, promoteEstimatesCommand),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND.signalEndMode, signalEndModeCommand),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND.signalStopRun, signalStopRunCommand),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND.showLineage, () =>
      LineagePanel.showOrFocus(
        context.extensionUri,
        (msg) => outputChannel?.appendLine(`[positron-nonmem] ${msg}`),
        runner,
        // Click-on-node → push Fit Inspector for that .lst directly,
        // without opening any editor (no tab, focus stays on the
        // lineage view). Reuses the existing resolveLstMode flow via
        // its public wrapper, then pipes through the same pushVariables
        // path the active-editor watcher uses.
        async (lstPath: string) => {
          const ctx = await resolveContextForLstUri(vscode.Uri.file(lstPath), {
            log: logVars,
            runner,
          });
          if (ctx) pushVariables(ctx);
        },
      ),
    ),
  );

  registerRunsTree(context, outputChannel);
  registerActiveRunsTree(context, outputChannel);
  registerFitInspector(context, outputChannel);
  registerLstDecorations(context, outputChannel);
  await registerRuntime(context, outputChannel);

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => void refreshVariablesForEditor(editor)),
  );
  void refreshVariablesForEditor(vscode.window.activeTextEditor);

  outputChannel.appendLine('[positron-nonmem] extension activated.');
}

async function refreshVariablesForEditor(editor: vscode.TextEditor | undefined): Promise<void> {
  // One context drives two views: Variables pane (declarations only)
  // and Fit Inspector (declarations + fit overlay + sumo summary).
  // Behaviour rules:
  //   - editor === undefined (no editor / window blurred) → clear both.
  //   - editor exists but is an unrecognised type (Output channel,
  //     terminal, …) → keep the last context. Otherwise glancing at
  //     the Output channel to read logs blanks the panel, which is
  //     consistently surprising.
  //   - editor is a .mod/.ctl/.lst → resolve and update.
  if (!editor) {
    pushVariables(null);
    return;
  }
  const ctx = await resolveVariablesContext(editor, { log: logVars, runner });
  if (ctx === null) return; // unrecognised editor — keep last state
  pushVariables(ctx);
}

function pushVariables(ctx: VariablesContext | null): void {
  if (runtimeManager) {
    for (const session of runtimeManager.getSessions()) {
      session.setParsedModel(ctx?.model ?? null, ctx?.modUri ?? null);
    }
  }
  if (fitInspector) {
    const cfg = vscode.workspace.getConfiguration('nonmem');
    const payload = buildInspectorPayload(ctx?.model ?? null, {
      lstPath: ctx?.lstPath,
      fit: ctx?.fit,
      sumo: ctx?.sumo,
      lst: ctx?.lst,
      runrecord: ctx?.runrecord,
      prderr: ctx?.prderr,
      fmsg: ctx?.fmsg,
      cor: ctx?.cor,
      cnv: ctx?.cnv,
      trajectories: ctx?.trajectories,
      xmlEstimationOptions: ctx?.xmlEstimationOptions,
      xmlEstimationResults: ctx?.xmlEstimationResults,
      xmlCovarianceOptions: ctx?.xmlCovarianceOptions,
      lstEstRecords: ctx?.lstEstRecords,
      lstCovRecord: ctx?.lstCovRecord,
      lstTolerances: ctx?.lstTolerances,
      shrinkageWarnPct: cfg.get<number>('shrinkageWarnPct', 30),
      rseWarnPct: cfg.get<number>('rseWarnPct', 100),
      rseThetaWarnPct: cfg.get<number>('rseThetaWarnPct', 30),
      rseOmegaWarnPct: cfg.get<number>('rseOmegaWarnPct', 50),
      pValWarnThreshold: cfg.get<number>('pValWarnThreshold', 0.1),
      pValBadThreshold: cfg.get<number>('pValBadThreshold', 0.05),
      corrRedFlagThreshold: cfg.get<number>('corrRedFlagThreshold', 0.95),
      corrWarnThreshold: cfg.get<number>('corrWarnThreshold', 0.9),
    });
    fitInspector.update(payload, ctx?.modUri);
  }
}

/** Diagnostic logger for the active-editor → Variables / Fit Inspector resolution path. */
function logVars(message: string): void {
  outputChannel?.appendLine(`[positron-nonmem][vars] ${message}`);
}

/**
 * Open `uri` and reveal `line` (0-based) — wired into NonmemSession via the
 * `navigator` dep so a Variables-pane double-click on an equation row jumps
 * to the assignment. Range start==end so we only place the caret rather than
 * highlight a span.
 */
function navigateToFileLine(uri: vscode.Uri, line: number): void {
  const range = new vscode.Range(line, 0, line, 0);
  void vscode.window.showTextDocument(uri, { selection: range, preserveFocus: false });
}

export function deactivate(): void {
  runtimeManager?.dispose();
  runtimeManager = undefined;
  outputChannel?.dispose();
  outputChannel = undefined;
}

async function registerRuntime(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
): Promise<void> {
  let positron;
  try {
    positron = getPositron();
  } catch (e) {
    if (e instanceof PositronApiUnavailableError) {
      channel.appendLine(`[warn] ${e.message}`);
      return;
    }
    throw e;
  }

  const nmVersions = await resolveNmVersions(channel);
  if (nmVersions.length === 0) {
    channel.appendLine(
      `[warn] no NONMEM versions found in psn.conf — runtime not registered. ` +
        `Install PsN, connect via Positron Remote SSH to a host that has it, ` +
        `or add a [nm_versions] entry to ~/psn.conf.`,
    );
    return;
  }
  runtimeManager = new NonmemRuntimeManager(context, {
    positron,
    nmVersions,
    runner,
    navigator: navigateToFileLine,
  });
  context.subscriptions.push(
    positron.runtime.registerLanguageRuntimeManager('nmtran', runtimeManager),
  );
  for (const e of nmVersions) {
    channel.appendLine(
      `[positron-nonmem] registered NONMEM ${e.version} (${e.label}) -> '${e.installDir}'.`,
    );
  }
}

/**
 * Read PsN's psn.conf [nm_versions] entries and drop any whose
 * `installDir` doesn't exist on disk — picking a phantom in the runtime
 * picker would fail at run time when `psn execute -nm_version=<phantom>`
 * resolves. Surfaces both the kept and dropped entries to the Output
 * channel so the user can see what happened.
 *
 * `fs.stat` and the `runner` always share a host: the extension runs in
 * Positron's extension host, and a Positron Remote SSH window puts that
 * host on the remote machine — so both `node:fs` and `LocalRunner` see
 * the same filesystem. If we ever introduce a Runner that runs commands
 * on a *different* host than the extension, this check needs to move
 * through the runner too.
 */
async function resolveNmVersions(channel: vscode.OutputChannel): Promise<NmVersionEntry[]> {
  let entries: NmVersionEntry[];
  try {
    entries = await fetchNmVersions(runner);
  } catch (e) {
    channel.appendLine(`[positron-nonmem] could not read psn.conf: ${errMsg(e)}`);
    return [];
  }
  const kept: NmVersionEntry[] = [];
  for (const entry of entries) {
    try {
      const stat = await fs.stat(entry.installDir);
      if (stat.isDirectory()) {
        kept.push(entry);
      } else {
        channel.appendLine(
          `[positron-nonmem] dropped psn.conf entry '${entry.label}' (path is not a directory): ${entry.installDir}`,
        );
      }
    } catch {
      channel.appendLine(
        `[positron-nonmem] dropped psn.conf entry '${entry.label}' (missing on disk): ${entry.installDir}`,
      );
    }
  }
  return kept;
}

function registerRunsTree(context: vscode.ExtensionContext, channel: vscode.OutputChannel): void {
  const provider = new RunsTreeProvider(() => discoverRuns());
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.lst');
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(VIEW_ID.runs, provider),
    vscode.commands.registerCommand(COMMAND.refreshRuns, () => provider.refresh()),
    watcher,
    watcher.onDidCreate(() => provider.refresh()),
    watcher.onDidChange(() => provider.refresh()),
    watcher.onDidDelete(() => provider.refresh()),
  );
  channel.appendLine('[positron-nonmem] registered runs tree view.');
}

function registerLstDecorations(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
): void {
  const provider = new LstFileDecorationProvider(runner, (msg) =>
    channel.appendLine(`[positron-nonmem] ${msg}`),
  );
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(provider),
    { dispose: () => provider.dispose() },
  );
  channel.appendLine('[positron-nonmem] registered .lst file-decoration provider.');
}

function registerFitInspector(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
): void {
  fitInspector = new FitInspectorProvider(context.extensionUri, navigateToFileLine, (msg) =>
    channel.appendLine(`[positron-nonmem] ${msg}`),
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(FitInspectorProvider.viewType, fitInspector),
  );
  channel.appendLine('[positron-nonmem] registered fit inspector view.');
}

function registerActiveRunsTree(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
): void {
  const provider = new ActiveRunsTreeProvider(activeRunsTracker);
  const watcher = new ActiveRunsWatcher({
    tracker: activeRunsTracker,
    log: (msg: string) => channel.appendLine(`[positron-nonmem] ${msg}`),
  });
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(VIEW_ID.activeRuns, provider),
    watcher,
  );
  channel.appendLine('[positron-nonmem] registered active runs tree view + watcher.');
}

/**
 * "Run Current Model" command — fires `psn execute` and returns. The
 * `ActiveRunsWatcher` (registered alongside the Active Runs tree)
 * picks the run up via filesystem events when PsN creates
 * `<modelfitDir>/NM_run1/psn.mod`, so this function is a thin shim:
 *
 *   - Spawn the run, fire-and-forget via `runModel`.
 *   - Log success/failure to the Output channel for diagnostics.
 *   - Trigger a refresh of the Runs tree on completion (no behaviour
 *     change vs before — the .lst watcher already does this anyway).
 *
 * Tracker registration happens entirely in the watcher, so Console-
 * typed `execute run001.mod` and runs started from external terminals
 * all show up in Active Runs the same way as runs initiated here.
 */
function runCurrentModel(): void {
  const modelPath = resolveActiveModelPath();
  if (!modelPath) return;
  const nmVersionLabel = activeNmVersionLabel();
  const versionTag = nmVersionLabel ? ` (-nm_version=${nmVersionLabel})` : '';
  // Captured BEFORE the runModel call so the .then/.catch can
  // discriminate "an entry the watcher made for THIS dispatch" from
  // any stale done/failed rows for previous runs of the same .mod.
  // See reconcileCompletion for why this matters.
  const dispatchedAt = Date.now();
  log(`runModel: launching for ${modelPath}${versionTag}`);
  void runModel({
    modelPath,
    runner,
    executeBinary: DEFAULT_EXECUTE_BINARY,
    nmVersionLabel,
  }).then(
    (result) => {
      const exit = result.exitCode ?? 'unknown';
      const ofv = result.ofv !== null ? `, OFV=${result.ofv}` : '';
      log(`runModel: EXIT=${exit}${ofv} -> ${result.lstPath}`);
      if (result.modelfitDir) log(`runModel: aux files in ${result.modelfitDir}`);
      reconcileCompletion(activeRunsTracker, {
        modelPath,
        dispatchedAt,
        finalOfv: result.ofv,
        modelfitDir: result.modelfitDir,
        lstPath: result.lstPath,
      });
      void vscode.commands.executeCommand(COMMAND.refreshRuns);
    },
    (e: unknown) => {
      const msg = scrubPrivate(errMsg(e));
      log(`runModel: failed — ${msg}`);
      reconcileFailure(activeRunsTracker, { modelPath, dispatchedAt, errorMessage: msg });
    },
  );
}

/** Recognised NMTRAN control-stream extensions. Used as a fallback when vscode-nmtran (which sets languageId=nmtran) isn't installed. */
const NMTRAN_FILE_EXTENSIONS = new Set(['.mod', '.ctl']);

/** Resolve the active editor's .mod file path, or null with a user-facing error toast. */
function resolveActiveModelPath(): string | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isNmtranEditor(editor)) {
    void vscode.window.showErrorMessage(
      'Positron NONMEM: open an NMTRAN .mod file in the active editor first.',
    );
    return null;
  }
  return editor.document.uri.fsPath;
}

function isNmtranEditor(editor: vscode.TextEditor): boolean {
  if (editor.document.languageId === 'nmtran') return true;
  const ext = path.extname(editor.document.uri.fsPath).toLowerCase();
  return NMTRAN_FILE_EXTENSIONS.has(ext);
}

/**
 * Click-handler for an Active Runs tree entry. Delegates the policy
 * decision (which file/toast based on run state) to `chooseRunAction`
 * — a pure helper that snapshots state for TOCTOU safety — and only
 * does the vscode side effects here.
 */
async function openRun(runId: string): Promise<void> {
  const run = activeRunsTracker.get(runId);
  if (!run) return;
  const action = await chooseRunAction(run, findLatestModelfitDir);
  const prefix = `${path.basename(run.modelPath)}:`;
  if (action.kind === 'showError') {
    // Prefer NONMEM's own FMSG (rich NMtran error detail) when
    // available — it's the canonical NONMEM error file. Otherwise
    // open a virtual readonly doc carrying the parsed error
    // message (covers PsN early-die cases where FMSG never existed).
    const fmsgPath = action.modelfitDir ? path.join(action.modelfitDir, 'NM_run1', 'FMSG') : null;
    if (fmsgPath) {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fmsgPath));
        await vscode.window.showTextDocument(doc, { preview: false });
        return;
      } catch {
        // FMSG missing or unreadable; fall through to virtual doc.
      }
    }
    const doc = await vscode.workspace.openTextDocument({
      language: 'plaintext',
      content: `${action.title}\n\n${action.body}\n`,
    });
    await vscode.window.showTextDocument(doc, { preview: false });
    return;
  }
  if (action.kind === 'wait') {
    await vscode.window.showInformationMessage(`${prefix} ${action.message}`);
    return;
  }
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(action.path));
    await vscode.window.showTextDocument(doc, { preview: false });
  } catch {
    await vscode.window.showWarningMessage(`${prefix} could not open ${action.path}`);
  }
}

/**
 * Right-click an Active Runs `done` entry → "Promote Estimates to New
 * Model". Shells out to PsN's `update_inits`, which reads the run's
 * `<basename>.lst` and writes a new `.mod` with `$THETA`/`$OMEGA`/`$SIGMA`
 * substituted with the converged estimates.
 *
 * Invocation:
 *   - Right-click in the Active Runs view → first arg is the
 *     `ActiveRun` element (vscode passes the tree element to
 *     view/item/context menu commands).
 *   - Command palette → no arg; we toast a hint and bail.
 *
 * The user gets an input box prefilled with the bumped name
 * (`run001.mod` → `run002.mod`, or `m.mod` → `m+1.mod` for non-numeric
 * stems) so the rare custom-name case is one keystroke away.
 */
async function promoteEstimatesCommand(arg?: ActiveRun): Promise<void> {
  if (!arg || typeof arg !== 'object' || typeof arg.modelPath !== 'string') {
    await vscode.window.showInformationMessage(
      'Positron NONMEM: right-click a finished run in the Active Runs view to promote its estimates.',
    );
    return;
  }
  if (arg.state !== 'done') {
    await vscode.window.showWarningMessage(
      `Positron NONMEM: can't promote estimates from a ${arg.state} run — wait for it to finish first.`,
    );
    return;
  }

  const defaultPath = computeNextModelName(arg.modelPath);
  const defaultBase = path.basename(defaultPath);
  const newName = await vscode.window.showInputBox({
    title: 'Promote Estimates to New Model',
    prompt: `update_inits will write a new .mod next to ${path.basename(arg.modelPath)}`,
    value: defaultBase,
    valueSelection: [0, defaultBase.length - path.extname(defaultBase).length],
    validateInput: (v) => (v && v.trim() ? null : 'name required'),
  });
  if (!newName) return;

  log(`promoteEstimates: ${arg.modelPath} → ${newName}`);
  try {
    const { outputModelPath } = await promoteEstimates({
      modelPath: arg.modelPath,
      outputName: newName,
      runner,
    });
    log(`promoteEstimates: wrote ${outputModelPath}`);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(outputModelPath));
    await vscode.window.showTextDocument(doc, { preview: false });
    void vscode.commands.executeCommand(COMMAND.refreshRuns);
  } catch (e) {
    const msg = scrubPrivate(errMsg(e));
    log(`promoteEstimates: failed — ${msg}`);
    await vscode.window.showErrorMessage(`Positron NONMEM: ${msg}`);
  }
}

/**
 * Right-click handler for "End current EM mode (next.sig)" on a running
 * Active Run. Sends `next.sig` to nmfe76's cwd (`<modelfitDir>/NM_run1/`).
 * NONMEM consumes the file at the next PRINT cycle and advances to the
 * next mode (burn-in -> accumulation, or one $EST -> the next).
 *
 * Empirical UX latency: ~10 iterations / 1 PRINT cycle (see
 * docs/empirical-notes.md). No confirmation modal — `next.sig` is
 * non-destructive.
 */
async function signalEndModeCommand(arg?: ActiveRun): Promise<void> {
  await sendSignalCommand(arg, 'next.sig', null);
}

/**
 * Right-click handler for "Stop run cleanly (stop.sig)". Thin wrapper —
 * the multi-`$EST`-warning + signal dispatch live in `sendSignalCommand`
 * keyed off the signal name (only `stop.sig` gates on chain length).
 */
async function signalStopRunCommand(arg?: ActiveRun): Promise<void> {
  await sendSignalCommand(arg, 'stop.sig', null);
}

/**
 * Shared body for both signal commands. Validates the arg, builds the
 * `stop.sig`-only multi-`$EST` warning if needed, calls `sendSignal`,
 * surfaces success/failure as a toast + Output channel line.
 */
async function sendSignalCommand(
  arg: ActiveRun | undefined,
  signal: SignalName,
  warningMessageOverride: string | null,
): Promise<void> {
  if (!arg || typeof arg !== 'object' || typeof arg.modelPath !== 'string') {
    await vscode.window.showInformationMessage(
      `Positron NONMEM: right-click a running entry in the Active Runs view to send ${signal}.`,
    );
    return;
  }
  if (arg.state !== 'running') {
    await vscode.window.showWarningMessage(
      `Positron NONMEM: can't send ${signal} to a ${arg.state} run — signal files only matter while NONMEM is iterating.`,
    );
    return;
  }
  if (!arg.modelfitDir) {
    await vscode.window.showWarningMessage(
      `Positron NONMEM: no modelfit_dir located yet for this run — wait for nmfe76 to start iterating, then retry.`,
    );
    return;
  }

  // stop.sig only: warn when the model has chained $EST records
  // (the IMP-EONLY refinement caveat). Read failures degrade silently
  // — the user explicitly asked for the signal, so we send it.
  let warningMessage = warningMessageOverride;
  if (signal === 'stop.sig' && warningMessage === null) {
    try {
      const text = await fs.readFile(arg.modelPath, 'utf8');
      const estCount = countEstimationRecords(text);
      if (estCount > 1) {
        warningMessage =
          `Stops at the current $EST. Remaining steps in the chain (${estCount - 1}) will be skipped — ` +
          `use "End current EM mode" to advance through them instead.`;
      }
    } catch (e) {
      log(`${signal}: read ${arg.modelPath} failed (${errMsg(e)}) — proceeding without multi-$EST warning`);
    }
  }

  if (warningMessage !== null) {
    const proceed = await vscode.window.showWarningMessage(
      warningMessage,
      { modal: true },
      `Send ${signal}`,
    );
    if (proceed !== `Send ${signal}`) {
      log(`${signal}: cancelled by user (${path.basename(arg.modelPath)})`);
      return;
    }
  }

  const result = await sendSignal({ modelfitDir: arg.modelfitDir, name: signal });
  if (result.ok) {
    log(`${signal}: sent to ${result.path}`);
    await vscode.window.showInformationMessage(
      `Positron NONMEM: ${signal} sent. NONMEM reacts at the next PRINT cycle.`,
    );
  } else {
    log(`${signal}: FAILED to write ${result.path} — ${result.error}`);
    await vscode.window.showErrorMessage(
      `Positron NONMEM: failed to send ${signal} — ${result.error ?? 'unknown error'}`,
    );
  }
}

/**
 * Pick the nm_version label for runModel: most-recent active session
 * (Set preserves insertion order; manager appends on createSession).
 * Returns undefined when no session is live, so PsN falls back to its
 * bundled default and runModel omits the `-nm_version` flag entirely.
 */
function activeNmVersionLabel(): string | undefined {
  const sessions = runtimeManager?.getSessions() ?? [];
  return sessions.at(-1)?.nmVersionLabel;
}

function log(message: string): void {
  outputChannel?.appendLine(`[positron-nonmem] ${message}`);
}

/**
 * Smoke-test command: opens the parsedModel response from vscode-nmtran's
 * `getParsedModel` API in a new JSON editor.
 */
async function showNmtranParsedModel(): Promise<void> {
  if (!resolveActiveModelPath()) return;
  const editor = vscode.window.activeTextEditor!;
  const result = await getNmtranParsedModel(editor.document.uri);
  if (result === null) {
    await vscode.window.showErrorMessage(
      'Positron NONMEM: vscode-nmtran did not return a parsedModel — is the extension installed and the document open?',
    );
    return;
  }
  const doc = await vscode.workspace.openTextDocument({
    language: 'json',
    content: JSON.stringify(result, null, 2),
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}
