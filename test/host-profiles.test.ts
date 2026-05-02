import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import {
  expandEnvVars,
  expandHomeDir,
  resolveHostProfile,
  HostProfileError,
} from '../src/host-profiles';

function fakeConfig(values: Record<string, unknown>): { get: <T>(key: string) => T | undefined } {
  return {
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  };
}

describe('expandEnvVars', () => {
  beforeEach(() => {
    process.env.POSITRON_NONMEM_TEST_VAR = 'resolved-value';
    process.env.POSITRON_NONMEM_TEST_VAR_B = 'second';
    delete process.env.POSITRON_NONMEM_NONEXISTENT;
  });

  afterEach(() => {
    delete process.env.POSITRON_NONMEM_TEST_VAR;
    delete process.env.POSITRON_NONMEM_TEST_VAR_B;
  });

  it('expands a single ${env:VAR} placeholder', () => {
    expect(expandEnvVars('hello ${env:POSITRON_NONMEM_TEST_VAR}')).toBe('hello resolved-value');
  });

  it('expands multiple placeholders in one string', () => {
    expect(expandEnvVars('${env:POSITRON_NONMEM_TEST_VAR}/${env:POSITRON_NONMEM_TEST_VAR_B}')).toBe(
      'resolved-value/second',
    );
  });

  it('returns empty for missing env vars (does not leave the placeholder)', () => {
    expect(expandEnvVars('hello ${env:POSITRON_NONMEM_NONEXISTENT}')).toBe('hello ');
  });

  it('passes through plain strings unchanged', () => {
    expect(expandEnvVars('plain string with no placeholders')).toBe(
      'plain string with no placeholders',
    );
  });
});

describe('expandHomeDir', () => {
  it('expands a leading tilde-slash to the user home directory', () => {
    const result = expandHomeDir('~/foo/bar');
    expect(result).not.toContain('~');
    expect(result.startsWith(os.homedir())).toBe(true);
  });

  it('passes absolute paths through unchanged', () => {
    expect(expandHomeDir('/absolute/path')).toBe('/absolute/path');
  });

  it('does not expand mid-string tildes', () => {
    expect(expandHomeDir('/path/with~tilde')).toBe('/path/with~tilde');
  });
});

describe('resolveHostProfile', () => {
  beforeEach(() => {
    process.env.POSITRON_NONMEM_TEST_HOST = 'host.example.invalid';
  });

  afterEach(() => {
    delete process.env.POSITRON_NONMEM_TEST_HOST;
  });

  it('throws when host is unset and env var resolves empty', () => {
    delete process.env.POSITRON_NONMEM_TEST_HOST;
    expect(() =>
      resolveHostProfile(fakeConfig({ user: 'alice', host: '${env:POSITRON_NONMEM_TEST_HOST}' })),
    ).toThrow(HostProfileError);
  });

  it('resolves a complete profile and applies defaults', () => {
    const profile = resolveHostProfile(
      fakeConfig({ user: 'alice', host: '${env:POSITRON_NONMEM_TEST_HOST}' }),
    );
    expect(profile.alias).toBe('primary');
    expect(profile.user).toBe('alice');
    expect(profile.host).toBe('host.example.invalid');
    expect(profile.port).toBe(22);
    expect(profile.auth).toBe('ssh-agent');
    expect(profile.remoteWorkspace).toBe('~/positron-nonmem');
    expect(profile.nmfeBinary).toBe('/opt/nm760/run/nmfe76');
    expect(profile.nonmemVersion).toBe('7.6.0');
  });

  it('rejects an unknown auth value with a helpful message', () => {
    expect(() =>
      resolveHostProfile(
        fakeConfig({ user: 'alice', host: 'host.example.invalid', auth: 'kerberos' }),
      ),
    ).toThrow(/auth must be one of/);
  });

  it('requires a private key path when auth = ssh-key', () => {
    expect(() =>
      resolveHostProfile(
        fakeConfig({ user: 'alice', host: 'host.example.invalid', auth: 'ssh-key' }),
      ),
    ).toThrow(HostProfileError);
  });
});
