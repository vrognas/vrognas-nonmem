import * as vscode from 'vscode';

// Privacy-preserving log surface. The Logger knows only the host alias; the resolved
// hostname must never reach this layer. Toasts and channel writes always pair so the
// user sees the same message in both surfaces.
export class Logger {
  constructor(
    private readonly channel: vscode.OutputChannel,
    private readonly alias: string,
  ) {}

  info(msg: string): void {
    this.channel.appendLine(`[${this.alias}] ${msg}`);
  }

  raw(msg: string): void {
    this.channel.appendLine(msg);
  }

  show(preserveFocus = true): void {
    this.channel.show(preserveFocus);
  }

  async successToast(msg: string): Promise<void> {
    this.info(msg);
    await vscode.window.showInformationMessage(`[${this.alias}] ${msg}`);
  }

  async errorToast(msg: string): Promise<void> {
    this.channel.appendLine(`[error] [${this.alias}] ${msg}`);
    await vscode.window.showErrorMessage(`[${this.alias}] ${msg}`);
  }
}
