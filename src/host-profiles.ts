import * as vscode from 'vscode';
import { CONFIG_HOST_SECTION, HOST_DEFAULTS } from './constants';
import type { TransportMode } from './transport';

// Connection details (HostName, User, Port, IdentityFile, ProxyJump, ...)
// come from the user's ~/.ssh/config via the system `ssh` CLI. The extension
// holds only the alias the user wants us to dial and the transport mode
// (auto / ssh / local). No hostnames or credentials ever live in workspace
// settings.
export interface HostProfile {
  alias: string;
  transport: TransportMode;
}

export class HostProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostProfileError';
  }
}

const VALID_TRANSPORTS: readonly TransportMode[] = ['auto', 'ssh', 'local'];

function isTransportMode(value: string): value is TransportMode {
  return (VALID_TRANSPORTS as readonly string[]).includes(value);
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
  const transportRaw = (config.get<string>('transport') ?? HOST_DEFAULTS.transport).trim();
  if (!isTransportMode(transportRaw)) {
    throw new HostProfileError(
      `${CONFIG_HOST_SECTION}.transport must be one of ${VALID_TRANSPORTS.join(' | ')} (got "${transportRaw}").`,
    );
  }
  return { alias, transport: transportRaw };
}
