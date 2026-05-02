// Picks a Transport implementation based on the host profile setting and,
// for the "auto" mode, a hostname-comparison heuristic.
//
// auto: run `ssh -G <alias>` to get the configured HostName, compare with
//       the local os.hostname(). If they match (case-insensitive, allowing
//       short-vs-FQDN), assume the extension host is already on the NONMEM
//       host and use LocalTransport. Otherwise SshTransport.
// ssh:   always SshTransport.
// local: always LocalTransport.
import * as os from 'os';
import { LocalTransport } from './local-transport';
import { SshTransport, resolveAlias } from './ssh-transport';
import type { Transport } from './types';
import type { HostProfile } from '../host-profiles';

export type TransportMode = 'auto' | 'ssh' | 'local';

export interface PickTransportOptions {
  /** Override hostname for tests; defaults to os.hostname(). */
  localHostname?: () => string;
}

export async function pickTransport(
  profile: HostProfile,
  opts: PickTransportOptions = {},
): Promise<Transport> {
  switch (profile.transport) {
    case 'ssh':
      return new SshTransport(profile.alias);
    case 'local':
      return new LocalTransport();
    case 'auto':
    default:
      return autoDetect(profile.alias, opts);
  }
}

async function autoDetect(alias: string, opts: PickTransportOptions): Promise<Transport> {
  const localHostname = (opts.localHostname ?? os.hostname)();
  let resolvedHostname: string;
  try {
    const resolved = await resolveAlias(alias);
    // If ssh -G echoed the alias as the hostname (no Host block match),
    // we still want to try matching against the alias itself — handles the
    // common case where the alias *is* the hostname.
    resolvedHostname = resolved.hostname;
  } catch {
    // ssh CLI not on PATH or other failure — fall back to ssh transport
    // and let it error meaningfully when actually invoked.
    return new SshTransport(alias);
  }
  if (hostnamesMatch(localHostname, resolvedHostname)) {
    return new LocalTransport();
  }
  return new SshTransport(alias);
}

/**
 * Compare two hostnames tolerantly. Match if either:
 *   - exact case-insensitive match, OR
 *   - their first label (before the first `.`) matches case-insensitively
 *     (so "qphcmp03" and "qphcmp03.example.com" are considered the same host).
 */
export function hostnamesMatch(a: string, b: string): boolean {
  const al = a.trim().toLowerCase();
  const bl = b.trim().toLowerCase();
  if (!al || !bl) return false;
  if (al === bl) return true;
  return al.split('.')[0] === bl.split('.')[0];
}
