import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  COMMAND,
  DEFAULT_NMFE_BINARY,
  OUTPUT_CHANNEL_NAME,
  SETTING,
  VIEW_ID,
} from './constants';
import { getNmtranParsedModel } from './nmtran-client';
import { getPositron, PositronApiUnavailableError } from './positron-api';
import { LocalRunner } from './runner';
import { runModel } from './runtime/run-model';
import { NonmemRuntimeManager } from './runtime/runtime-manager';
import { discoverRuns } from './views/runs-discovery';
import { RunsTreeProvider } from './views/runs-tree-provider';

let outputChannel: vscode.OutputChannel | undefined;
let runtimeManager: NonmemRuntimeManager | undefined;
const runner = new LocalRunner();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(outputChannel);

  context.subscriptions.push(vscode.commands.registerCommand(COMMAND.runModel, runCurrentModel));
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND.showNmtranParsedModel, showNmtranParsedModel),
  );

  registerRunsTree(context, outputChannel);
  await registerRuntime(context, outputChannel);

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

/** Single-quote a string for safe shell interpolation. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
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

  const nmfe = nmfeBinary();
  // Probe: quote the binary path so user-supplied settings can't smuggle
  // in shell metacharacters. nmfe76 with no args writes a banner to stdout
  // then exits non-zero; we tolerate any exit code and just look for output.
  const probe = await runner
    .run(`${shellQuote(nmfe)} 2>&1 | head -1; echo EXIT=$?`)
    .catch(() => null);
  if (!probe || !/EXIT=/.test(probe.stdout)) {
    channel.appendLine(
      `[warn] could not invoke '${nmfe}' — runtime not registered. Install NONMEM locally, ` +
        `connect via Positron Remote SSH to a host that has it, or set positronNonmem.nmfeBinary.`,
    );
    return;
  }
  const versionLine = probe.stdout.split('\n').find((l) => l && !l.startsWith('EXIT=')) ?? '';
  const version = parseNonmemVersion(versionLine);

  runtimeManager = new NonmemRuntimeManager(context, {
    positron,
    nonmemVersion: version,
    runner,
    navigator: navigateToFileLine,
  });
  context.subscriptions.push(
    positron.runtime.registerLanguageRuntimeManager('nmtran', runtimeManager),
  );
  channel.appendLine(`[positron-nonmem] registered NONMEM ${version} runtime via '${nmfe}'.`);
}

/** Extract a NONMEM version from a banner line (best-effort; falls back to "unknown"). */
function parseNonmemVersion(line: string): string {
  const m = /\b(\d+\.\d+(?:\.\d+)?)\b/.exec(line);
  return m ? m[1] : 'unknown';
}

function nmfeBinary(): string {
  return (
    vscode.workspace.getConfiguration().get<string>(SETTING.nmfeBinary)?.trim() ||
    DEFAULT_NMFE_BINARY
  );
}

function registerRunsTree(
  context: vscode.ExtensionContext,
  channel: vscode.OutputChannel,
): void {
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

/**
 * "Run Current Model" command — runs nmfe76 in the active .mod's directory,
 * with classic NONMEM naming (`<basename>.lst` next to the .mod).
 */
async function runCurrentModel(): Promise<void> {
  const target = resolveActiveModelTarget();
  if (!target) return;
  const { modelPath } = target;
  log(`runModel: launching for ${modelPath}`);
  try {
    const result = await runModel({ modelPath, runner, nmfeBinary: nmfeBinary() });
    const exit = result.exitCode ?? 'unknown';
    const ofv = result.ofv !== null ? `, OFV=${result.ofv}` : '';
    log(`runModel: EXIT=${exit}${ofv} -> ${result.lstPath}`);
    await vscode.commands.executeCommand(COMMAND.refreshRuns);
    await vscode.window.showInformationMessage(
      `${path.basename(modelPath)}: EXIT=${exit}${ofv}`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`runModel: failed — ${msg}`);
    await vscode.window.showErrorMessage(`Positron NONMEM: run failed — ${msg}`);
  }
}

interface ActiveModelTarget {
  modelPath: string;
}

/** Recognised NMTRAN control-stream extensions. Used as a fallback when vscode-nmtran (which sets languageId=nmtran) isn't installed. */
const NMTRAN_FILE_EXTENSIONS = new Set(['.mod', '.ctl']);

/** Resolve the active editor's .mod file path, or null with a user-facing error toast. */
function resolveActiveModelTarget(): ActiveModelTarget | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isNmtranEditor(editor)) {
    void vscode.window.showErrorMessage(
      'Positron NONMEM: open an NMTRAN .mod file in the active editor first.',
    );
    return null;
  }
  return { modelPath: editor.document.uri.fsPath };
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
 * `getParsedModel` API in a new JSON editor.
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
