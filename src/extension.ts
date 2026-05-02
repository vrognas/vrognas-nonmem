import * as vscode from 'vscode';
import { COMMAND, OUTPUT_CHANNEL_NAME } from './constants';
import { resolveHostProfile, HostProfileError, type HostProfile } from './host-profiles';
import { connectAndRun, SshTransportError } from './ssh-transport';
import { Logger } from './logger';
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

async function testConnection(): Promise<void> {
  const channel = ensureChannel();
  channel.show(true);

  const profile = await resolveProfileOrReport(channel);
  if (!profile) return;

  const log = new Logger(channel, profile.alias);
  await runUnameProbe(profile, log);
}

function ensureChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    outputChannel.appendLine('[warn] outputChannel was undefined at command time; recreated.');
  }
  return outputChannel;
}

async function resolveProfileOrReport(
  channel: vscode.OutputChannel,
): Promise<HostProfile | undefined> {
  try {
    return resolveHostProfile();
  } catch (e) {
    if (e instanceof HostProfileError) {
      channel.appendLine(`[error] ${e.message}`);
      await vscode.window.showErrorMessage(e.message);
      return undefined;
    }
    throw e;
  }
}

async function runUnameProbe(profile: HostProfile, log: Logger): Promise<void> {
  log.info('connecting via ssh CLI...');
  try {
    const result = await connectAndRun(profile.alias, 'uname -a');
    log.info(`connected. uname: ${result.stdout.trim()}`);
    if (result.stderr.trim()) {
      log.info(`stderr: ${result.stderr.trim()}`);
    }
    if (result.code !== 0) {
      log.info(`remote exit code: ${result.code}`);
    }
    await log.successToast('connected.');
  } catch (e) {
    if (e instanceof SshTransportError) {
      await log.errorToast(e.message);
      return;
    }
    throw e;
  }
}
