import { describe, it, expect } from 'vitest';
import { resolveHostProfile, HostProfileError } from '../src/host-profiles';

function fakeConfig(values: Record<string, unknown>): { get: <T>(key: string) => T | undefined } {
  return {
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  };
}

describe('resolveHostProfile', () => {
  it('returns the configured alias', () => {
    expect(resolveHostProfile(fakeConfig({ alias: 'production' })).alias).toBe('production');
  });

  it('falls back to the "primary" default when alias is unset', () => {
    expect(resolveHostProfile(fakeConfig({})).alias).toBe('primary');
  });

  it('trims surrounding whitespace from alias', () => {
    expect(resolveHostProfile(fakeConfig({ alias: '  staging  ' })).alias).toBe('staging');
  });

  it('throws HostProfileError when alias is empty after trimming', () => {
    expect(() => resolveHostProfile(fakeConfig({ alias: '   ' }))).toThrow(HostProfileError);
  });

  it('defaults transport to "auto" when unset', () => {
    expect(resolveHostProfile(fakeConfig({ alias: 'a' })).transport).toBe('auto');
  });

  it('accepts the documented transport modes', () => {
    expect(resolveHostProfile(fakeConfig({ alias: 'a', transport: 'ssh' })).transport).toBe('ssh');
    expect(resolveHostProfile(fakeConfig({ alias: 'a', transport: 'local' })).transport).toBe(
      'local',
    );
    expect(resolveHostProfile(fakeConfig({ alias: 'a', transport: 'auto' })).transport).toBe(
      'auto',
    );
  });

  it('rejects an unknown transport mode with a helpful message', () => {
    expect(() => resolveHostProfile(fakeConfig({ alias: 'a', transport: 'tunneled' }))).toThrow(
      /transport must be one of/,
    );
  });
});
