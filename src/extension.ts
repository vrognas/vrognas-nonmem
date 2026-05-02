import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  COMMAND,
  LOCAL_RUNS_SUBDIR,
  NMFE_BINARY,
  OUTPUT_CHANNEL_NAME,
  REMOTE_RUN_ROOT,
} from './constants';
import { resolveHostProfile, HostProfileError } from './host-profiles';
import { getPositron, PositronApiUnavailableError } from './positron-api';
import { NonmemRuntimeManager } from './runtime/runtime-manager';
import { runModel } from './runtime/run-model';
import { pickTransport } from './transport';

let outputChannel: vscode.OutputChannel | undefined;
let runtimeManager: NonmemRuntimeManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(outputChannel);

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND.testConnection, testConnection),
  );
  context.subscriptions.push(vscode.commands.registerCommand(COMMAND.runModel, runCurrentModel));

  registerRuntime(context, outputChannel);

  outputChannel.appendLine('[positron-nonmem] extension activated.');
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
  runtimeManager = new NonmemRuntimeManager(context, { positron });
  context.subscriptions.push(
    positron.runtime.registerLanguageRuntimeManager('nmtran', runtimeManager),
  );
  channel.appendLine('[positron-nonmem] registered NMTRAN language runtime.');
}

/**
 * "Test Connection" command — routes a uname probe through the active
 * NONMEM runtime so output lands in the Console pane (not a separate
 * OutputChannel). Per the design rule "no notifications, use the session
 * pane", this is the entry point a new user clicks to verify their
 * SSH config is reachable.
 */
/**
 * "Run Current Model" command (M3 chunk 3A) — sftp the active editor's
 * `.mod` (and any `$DATA`-referenced dataset sibling), invoke nmfe76 in
 * a per-run remote subdir, pull `m.lst` back to the workspace's local
 * mirror, surface EXIT code in an info-message.
 *
 * No Variables-pane wiring, no OFV parsing, no manifest, no audit log —
 * those land in chunks 3B–3D. This is the absolute end-to-end minimum.
 */
async function runCurrentModel(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'nmtran') {
    await vscode.window.showErrorMessage(
      'Positron NONMEM: open an NMTRAN .mod file in the active editor first.',
    );
    return;
  }
  const modelPath = editor.document.uri.fsPath;
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  if (!workspaceFolder) {
    await vscode.window.showErrorMessage(
      'Positron NONMEM: the .mod file must live inside an open workspace folder.',
    );
    return;
  }
  let transport;
  try {
    transport = await pickTransport(resolveHostProfile());
  } catch (e) {
    if (e instanceof HostProfileError) {
      await vscode.window.showErrorMessage(`Positron NONMEM: ${e.message}`);
      return;
    }
    throw e;
  }
  const localRunsDir = path.join(workspaceFolder.uri.fsPath, LOCAL_RUNS_SUBDIR);
  outputChannel?.appendLine(`[positron-nonmem] runModel: launching for ${modelPath}`);
  try {
    const result = await runModel({
      modelPath,
      transport,
      remoteRoot: REMOTE_RUN_ROOT,
      localRunsDir,
      nmfeBinary: NMFE_BINARY,
    });
    outputChannel?.appendLine(
      `[positron-nonmem] runModel: ${result.runId} EXIT=${result.exitCode ?? 'unknown'} -> ${result.lstPath}`,
    );
    await vscode.window.showInformationMessage(
      `Run ${result.runId}: EXIT=${result.exitCode ?? 'unknown'}`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    outputChannel?.appendLine(`[positron-nonmem] runModel: failed — ${msg}`);
    await vscode.window.showErrorMessage(`Positron NONMEM: run failed — ${msg}`);
  }
}

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
