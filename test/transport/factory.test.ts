import { describe, it, expect } from 'vitest';
import { hostnamesMatch, pickTransport } from '../../src/transport/factory';
import { SshTransport } from '../../src/transport/ssh-transport';
import { LocalTransport } from '../../src/transport/local-transport';
import type { HostProfile } from '../../src/host-profiles';

describe('hostnamesMatch', () => {
  it('matches identical lowercase hostnames', () => {
    expect(hostnamesMatch('host', 'host')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(hostnamesMatch('HOST', 'host')).toBe(true);
  });

  it('matches short name against FQDN with same first label', () => {
    expect(hostnamesMatch('myhost', 'myhost.example.com')).toBe(true);
    expect(hostnamesMatch('myhost.example.com', 'myhost')).toBe(true);
  });

  it('rejects different first labels', () => {
    expect(hostnamesMatch('hosta', 'hostb')).toBe(false);
    expect(hostnamesMatch('hosta.example.com', 'hostb.example.com')).toBe(false);
  });

  it('rejects empty inputs', () => {
    expect(hostnamesMatch('', 'host')).toBe(false);
    expect(hostnamesMatch('host', '')).toBe(false);
  });

  it('trims whitespace before comparison', () => {
    expect(hostnamesMatch('  host  ', 'host')).toBe(true);
  });
});

describe('pickTransport', () => {
  function profile(transport: HostProfile['transport']): HostProfile {
    return { alias: 'unused-for-non-auto', transport };
  }

  it('returns SshTransport when transport = ssh (no host probe)', async () => {
    const t = await pickTransport(profile('ssh'));
    expect(t).toBeInstanceOf(SshTransport);
    expect(t.kind).toBe('ssh');
  });

  it('returns LocalTransport when transport = local (no host probe)', async () => {
    const t = await pickTransport(profile('local'));
    expect(t).toBeInstanceOf(LocalTransport);
    expect(t.kind).toBe('local');
  });

  // The auto-detection path actually calls `ssh -G <alias>`, which we
  // don't want to invoke from unit tests (slow, depends on user env).
  // It's exercised indirectly via the live-host smoke test (M2 manual
  // verification step) and via the hostnamesMatch unit tests above.
});
