import { describe, it, expect } from 'vitest';
import { buildRuntimeMetadata } from '../src/runtime/runtime-metadata';
import type { HostProfile } from '../src/host-profiles';

// Stand-in enum values so the test doesn't depend on the real Positron API.
// The metadata builder takes them as deps; we only care that they get set
// onto the result, not what their precise string form is at runtime.
const enums = {
  startupBehavior: 'explicit' as never,
  sessionLocation: 'workspace' as never,
};

function profile(alias: string): HostProfile {
  return { alias, transport: 'auto' };
}

describe('buildRuntimeMetadata', () => {
  it('produces a deterministic runtimeId derived from the alias', () => {
    const a = buildRuntimeMetadata(profile('primary'), enums);
    const b = buildRuntimeMetadata(profile('primary'), enums);
    expect(a.runtimeId).toBe(b.runtimeId);
    expect(a.runtimeId).toContain('primary');
  });

  it('different aliases get different runtimeIds', () => {
    const a = buildRuntimeMetadata(profile('primary'), enums);
    const b = buildRuntimeMetadata(profile('staging'), enums);
    expect(a.runtimeId).not.toBe(b.runtimeId);
  });

  it('targets the nmtran language id (companion to vscode-nmtran)', () => {
    const meta = buildRuntimeMetadata(profile('primary'), enums);
    expect(meta.languageId).toBe('nmtran');
  });

  it('display names include the alias for at-a-glance host identification', () => {
    const meta = buildRuntimeMetadata(profile('production'), enums);
    expect(meta.runtimeName).toContain('production');
    expect(meta.runtimeShortName).toBe('production');
  });

  it('stores the alias in extraRuntimeData for session restoration', () => {
    const meta = buildRuntimeMetadata(profile('primary'), enums);
    expect(meta.extraRuntimeData).toEqual({ hostAlias: 'primary' });
  });

  it('runtimePath uses the ssh:// pseudo-scheme (never a real fs path)', () => {
    const meta = buildRuntimeMetadata(profile('primary'), enums);
    expect(meta.runtimePath.startsWith('ssh://')).toBe(true);
  });
});
