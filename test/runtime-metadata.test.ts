import { describe, it, expect } from 'vitest';
import { buildRuntimeMetadata } from '../src/runtime/runtime-metadata';

const enums = {
  startupBehavior: 'explicit' as never,
  sessionLocation: 'workspace' as never,
};

describe('buildRuntimeMetadata', () => {
  it('keys runtimeId off the psn.conf label so multi-version entries are distinct', () => {
    const a = buildRuntimeMetadata({
      ...enums,
      nmVersion: { label: 'default', installDir: '/opt/nm760', version: '7.6' },
    });
    const b = buildRuntimeMetadata({
      ...enums,
      nmVersion: { label: '75', installDir: '/opt/nm751', version: '7.5' },
    });
    expect(a.runtimeId).not.toBe(b.runtimeId);
    expect(a.runtimeId).toContain('default');
    expect(b.runtimeId).toContain('75');
  });

  it('runtimeId is stable for the same label (session restoration)', () => {
    const a = buildRuntimeMetadata({
      ...enums,
      nmVersion: { label: 'default', installDir: '/opt/nm760', version: '7.6' },
    });
    const b = buildRuntimeMetadata({
      ...enums,
      nmVersion: { label: 'default', installDir: '/opt/nm760', version: '7.6' },
    });
    expect(a.runtimeId).toBe(b.runtimeId);
  });

  it('display name shows the version; non-default labels are appended for disambiguation', () => {
    const def = buildRuntimeMetadata({
      ...enums,
      nmVersion: { label: 'default', installDir: '/opt/nm760', version: '7.6' },
    });
    expect(def.runtimeName).toBe('NONMEM 7.6');
    expect(def.runtimeShortName).toBe('NONMEM 7.6');
    expect(def.languageVersion).toBe('7.6');

    const named = buildRuntimeMetadata({
      ...enums,
      nmVersion: { label: '75', installDir: '/opt/nm751', version: '7.5' },
    });
    expect(named.runtimeName).toBe('NONMEM 7.5 (75)');
    expect(named.runtimeShortName).toBe('NONMEM 7.5');
  });

  it('runtimePath is the canonical nmfe<NN> for display only — PsN resolves via the label', () => {
    const meta = buildRuntimeMetadata({
      ...enums,
      nmVersion: { label: 'default', installDir: '/opt/nm760', version: '7.6' },
    });
    expect(meta.runtimePath).toBe('/opt/nm760/run/nmfe76');
  });

  it('targets the nmtran languageId (companion to vscode-nmtran)', () => {
    const meta = buildRuntimeMetadata({
      ...enums,
      nmVersion: { label: 'default', installDir: '/opt/nm760', version: '7.6' },
    });
    expect(meta.languageId).toBe('nmtran');
  });

  it('stores the label in extraRuntimeData so createSession can read it back', () => {
    const meta = buildRuntimeMetadata({
      ...enums,
      nmVersion: { label: '74', installDir: '/opt/nm743', version: '7.4' },
    });
    expect(meta.extraRuntimeData).toEqual({ nmVersionLabel: '74' });
  });

  it('includes the inlined SVG icon (base64-encoded)', () => {
    const meta = buildRuntimeMetadata({
      ...enums,
      nmVersion: { label: 'default', installDir: '/opt/nm760', version: '7.6' },
    });
    expect(meta.base64EncodedIconSvg).toBeTruthy();
    expect(Buffer.from(meta.base64EncodedIconSvg!, 'base64').toString()).toContain('<svg');
  });
});
