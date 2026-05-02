import * as vscode from 'vscode';
import { CONFIG_HOST_SECTION, HOST_DEFAULTS } from './constants';

// All connection details (HostName, User, Port, IdentityFile, ProxyJump, ...)
// come from the user's ~/.ssh/config via the system `ssh` CLI. The extension
// holds only the alias the user wants us to dial. No hostnames or credentials
// ever live in workspace settings.
export interface HostProfile {
  alias: string;
}

export class HostProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostProfileError';
  }
}

type ConfigReader = Pick<vscode.WorkspaceConfiguration, 'get'>;

export function resolveHostProfile(
  config: ConfigReader = vscode.workspace.getConfiguration(CONFIG_HOST_SECTION),
): HostProfile {
  const alias = (config.get<string>('alias') ?? HOST_DEFAULTS.alias).trim();
  if (!alias) {
    throw new HostProfileError(
      `${CONFIG_HOST_SECTION}.alias is empty. Set it to a Host entry from your ~/.ssh/config (e.g. "primary").`,
    );
  }
  return { alias };
}
