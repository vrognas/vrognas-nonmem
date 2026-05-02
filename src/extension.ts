import * as vscode from 'vscode';
import { COMMAND, OUTPUT_CHANNEL_NAME } from './constants';
import { getPositron, PositronApiUnavailableError } from './positron-api';
import { NonmemRuntimeManager } from './runtime/runtime-manager';

let outputChannel: vscode.OutputChannel | undefined;
let runtimeManager: NonmemRuntimeManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(outputChannel);

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND.testConnection, testConnection),
  );

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
    const message = e instanceof Error ? e.message : String(e);
    await vscode.window.showErrorMessage(
      `Could not run NONMEM probe: ${message}. Start a NONMEM session from the runtime picker first.`,
    );
  }
}
