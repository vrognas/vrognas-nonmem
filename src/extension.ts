import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  COMMAND,
  LOCAL_AUDIT_FILE,
  LOCAL_RUNS_SUBDIR,
  NMFE_BINARY,
  NONMEM_VERSION,
  OUTPUT_CHANNEL_NAME,
  REMOTE_RUN_ROOT,
} from './constants';
import { resolveHostProfile, HostProfileError, type HostProfile } from './host-profiles';
import { getNmtranParsedModel } from './nmtran-client';
import { getPositron, PositronApiUnavailableError } from './positron-api';
import { NonmemRuntimeManager } from './runtime/runtime-manager';
import { runModel } from './runtime/run-model';
import { pickTransport, type Transport } from './transport';

let outputChannel: vscode.OutputChannel | undefined;
let runtimeManager: NonmemRuntimeManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(outputChannel);

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND.testConnection, testConnection),
  );
  context.subscriptions.push(vscode.commands.registerCommand(COMMAND.runModel, runCurrentModel));
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND.showNmtranParsedModel, showNmtranParsedModel),
  );

  registerRuntime(context, outputChannel);

  // Variables-pane wiring: when the active editor switches, fetch the
  // parsed-model from vscode-nmtran for the new file and push it to all
  // live NONMEM sessions. Each session relays its current model to any
  // open Variables comm.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => void refreshVariablesForEditor(editor)),
  );
  void refreshVariablesForEditor(vscode.window.activeTextEditor);

  outputChannel.appendLine('[positron-nonmem] extension activated.');
}

async function refreshVariablesForEditor(editor: vscode.TextEditor | undefined): Promise<void> {
  if (!runtimeManager) return;
  const sessions = runtimeManager.getSessions();
  if (sessions.length === 0) return;
  const target = editor && isNmtranEditor(editor) ? editor : null;
  const uri = target?.document.uri ?? null;
  const model = target ? await getNmtranParsedModel(target.document.uri) : null;
  for (const session of sessions) session.setParsedModel(model, uri);
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

function registerRuntime(context: vscode.ExtensionContext, channel: vscode.OutputChannel): void {
  let positron;
  try {
    positron = getPositron();
  } catch (e) {
    if (e instanceof PositronApiUnavailableError) {
      // engines.positron in package.json should make this unreachable in
      // practice; if it ever fires it means we're in plain VSCode and the
      // user installed us anyway. Surface clearly and skip runtime setup.
      channel.appendLine(`[warn] ${e.message}`);
      return;
    }
    throw e;
  }
  runtimeManager = new NonmemRuntimeManager(context, { positron, navigator: navigateToFileLine });
  context.subscriptions.push(
    positron.runtime.registerLanguageRuntimeManager('nmtran', runtimeManager),
  );
  channel.appendLine('[positron-nonmem] registered NMTRAN language runtime.');
}

/**
 * "Run Current Model" command (M3 chunks 3A–3C) — uploads the active
 * `.mod` (plus any `$DATA`-referenced dataset sibling) to a per-run
 * remote subdir, runs nmfe76, pulls m.lst (mandatory) and m.ext
 * (best-effort) back to `<workspace>/.positron-nonmem/runs/<runId>/`,
 * writes a manifest.json with hashes/timestamps/hostAlias, and appends
 * one audit-log line. Surface EXIT and OFV in an info-message.
 *
 * Variables-pane wiring (3D) and the live-tail status bar (M3 plan)
 * still arrive later.
 */
async function runCurrentModel(): Promise<void> {
  const target = resolveActiveModelTarget();
  if (!target) return;
  const { modelPath, workspaceFolder } = target;

  let profile: HostProfile;
  let transport: Transport;
  try {
    profile = resolveHostProfile();
    transport = await pickTransport(profile);
  } catch (e) {
    if (e instanceof HostProfileError) {
      await vscode.window.showErrorMessage(`Positron NONMEM: ${e.message}`);
      return;
    }
    throw e;
  }

  const localRunsDir = path.join(workspaceFolder.uri.fsPath, LOCAL_RUNS_SUBDIR);
  const auditLogPath = path.join(workspaceFolder.uri.fsPath, LOCAL_AUDIT_FILE);
  log(`runModel: launching for ${modelPath}`);
  try {
    const result = await runModel({
      modelPath,
      transport,
      remoteRoot: REMOTE_RUN_ROOT,
      localRunsDir,
      nmfeBinary: NMFE_BINARY,
      hostAlias: profile.alias,
      nonmemVersion: NONMEM_VERSION,
      auditLogPath,
    });
    const exit = result.exitCode ?? 'unknown';
    const ofv = result.ofv !== null ? `, OFV=${result.ofv}` : '';
    log(`runModel: ${result.runId} EXIT=${exit}${ofv} -> ${result.lstPath}`);
    await vscode.window.showInformationMessage(`Run ${result.runId}: EXIT=${exit}${ofv}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`runModel: failed — ${msg}`);
    await vscode.window.showErrorMessage(`Positron NONMEM: run failed — ${msg}`);
  }
}

interface ActiveModelTarget {
  modelPath: string;
  workspaceFolder: vscode.WorkspaceFolder;
}

/** Recognised NMTRAN control-stream extensions. Used as a fallback when vscode-nmtran (which sets languageId=nmtran) isn't installed. */
const NMTRAN_FILE_EXTENSIONS = new Set(['.mod', '.ctl']);

/** Resolve the active editor's .mod file plus its workspace folder, or null with a user-facing error toast. */
function resolveActiveModelTarget(): ActiveModelTarget | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isNmtranEditor(editor)) {
    void vscode.window.showErrorMessage(
      'Positron NONMEM: open an NMTRAN .mod file in the active editor first.',
    );
    return null;
  }
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  if (!workspaceFolder) {
    void vscode.window.showErrorMessage(
      'Positron NONMEM: the .mod file must live inside an open workspace folder.',
    );
    return null;
  }
  return { modelPath: editor.document.uri.fsPath, workspaceFolder };
}

function isNmtranEditor(editor: vscode.TextEditor): boolean {
  if (editor.document.languageId === 'nmtran') return true;
  const ext = path.extname(editor.document.uri.fsPath).toLowerCase();
  return NMTRAN_FILE_EXTENSIONS.has(ext);
}

function log(message: string): void {
  outputChannel?.appendLine(`[positron-nonmem] ${message}`);
}

/**
 * Smoke-test command: opens the parsedModel response from vscode-nmtran's
 * `getParsedModel` API in a new JSON editor. Verifies the cross-extension
 * API path before we build Variables-pane wiring on top of it.
 */
async function showNmtranParsedModel(): Promise<void> {
  const target = resolveActiveModelTarget();
  if (!target) return;
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

/**
 * "Test Connection" command — routes a uname probe through the active
 * NONMEM runtime so output lands in the Console pane (not a separate
 * OutputChannel). Per the design rule "no notifications, use the session
 * pane", this is the entry point a new user clicks to verify their
 * SSH config is reachable.
 */
async function testConnection(): Promise<void> {
  let positron;
  try {
    positron = getPositron();
  } catch (e) {
    if (e instanceof PositronApiUnavailableError) {
      await vscode.window.showErrorMessage(e.message);
      return;
    }
    throw e;
  }

  try {
    await positron.runtime.executeCode('nmtran', 'uname -a', true /* focus the Console */);
  } catch (e) {
    // Anything that goes wrong during the run (transport errors, non-zero
    // exit, no active session) is already shown in the Console pane via the
    // session's emitError / emitStream — no toast on top of that. We log
    // for diagnostic purposes only; Positron's own error string is opaque
    // (sometimes a bare object) so we don't try to format it for users.
    console.warn('[positron-nonmem] testConnection: executeCode rejected', e);
  }
}
