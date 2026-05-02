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

  it('trims surrounding whitespace', () => {
    expect(resolveHostProfile(fakeConfig({ alias: '  staging  ' })).alias).toBe('staging');
  });

  it('throws HostProfileError when alias is empty after trimming', () => {
    expect(() => resolveHostProfile(fakeConfig({ alias: '   ' }))).toThrow(HostProfileError);
  });
});
