import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { CONFIG_HOST_SECTION, HOST_DEFAULTS } from './constants';

export type AuthMethod = 'ssh-agent' | 'ssh-key';
const VALID_AUTH: readonly AuthMethod[] = ['ssh-agent', 'ssh-key'];

export interface HostProfile {
  alias: string;
  user: string;
  host: string;
  port: number;
  auth: AuthMethod;
  privateKeyPath?: string;
  remoteWorkspace: string;
  nmfeBinary: string;
  nonmemVersion: string;
}

export class HostProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostProfileError';
  }
}

const ENV_VAR_PATTERN = /\$\{env:([A-Z_][A-Z0-9_]*)\}/gi;

export function expandEnvVars(value: string): string {
  return value.replace(ENV_VAR_PATTERN, (_, name) => process.env[name] ?? '');
}

export function expandHomeDir(p: string): string {
  if (p === '~') {
    return os.homedir();
  }
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

type ConfigReader = Pick<vscode.WorkspaceConfiguration, 'get'>;

function getString(config: ConfigReader, key: string): string {
  return config.get<string>(key) ?? '';
}

function getExpandedString(config: ConfigReader, key: string): string {
  return expandEnvVars(getString(config, key));
}

export function resolveHostProfile(
  config: ConfigReader = vscode.workspace.getConfiguration(CONFIG_HOST_SECTION),
): HostProfile {
  const alias = getString(config, 'alias') || HOST_DEFAULTS.alias;
  const user = getExpandedString(config, 'user');
  const host = getExpandedString(config, 'host');
  const port = config.get<number>('port') ?? HOST_DEFAULTS.port;
  const authRaw = getString(config, 'auth') || HOST_DEFAULTS.auth;
  const privateKeyPathRaw = config.get<string>('privateKeyPath');
  const privateKeyPath = privateKeyPathRaw
    ? expandHomeDir(expandEnvVars(privateKeyPathRaw))
    : undefined;
  const remoteWorkspace = getString(config, 'remoteWorkspace') || HOST_DEFAULTS.remoteWorkspace;
  const nmfeBinary = getString(config, 'nmfeBinary') || HOST_DEFAULTS.nmfeBinary;
  const nonmemVersion = getString(config, 'nonmemVersion') || HOST_DEFAULTS.nonmemVersion;

  if (!user) {
    throw new HostProfileError(
      `${CONFIG_HOST_SECTION}.user is unset (or its env var resolved to empty).`,
    );
  }
  if (!host) {
    throw new HostProfileError(
      `${CONFIG_HOST_SECTION}.host is unset. Set $env:POSITRON_NONMEM_HOST or override in workspace settings.`,
    );
  }
  if (!isAuthMethod(authRaw)) {
    throw new HostProfileError(
      `${CONFIG_HOST_SECTION}.auth must be one of ${VALID_AUTH.join(' | ')} (got "${authRaw}").`,
    );
  }
  if (authRaw === 'ssh-key' && !privateKeyPath) {
    throw new HostProfileError(
      `${CONFIG_HOST_SECTION}.privateKeyPath is required when auth = "ssh-key".`,
    );
  }

  return {
    alias,
    user,
    host,
    port,
    auth: authRaw,
    privateKeyPath,
    remoteWorkspace,
    nmfeBinary,
    nonmemVersion,
  };
}

function isAuthMethod(value: string): value is AuthMethod {
  return (VALID_AUTH as readonly string[]).includes(value);
}
