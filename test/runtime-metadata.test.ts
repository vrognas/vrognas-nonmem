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

  it('truncates long host-leaky labels (no full hostname in runtimeId)', () => {
    // psn.conf labels are user-controlled. A label like
    // `nm760-on-myserver.corp.example.com` would otherwise embed the
    // hostname verbatim in `runtimeId`, which Positron may surface to
    // crash reporters / telemetry. Truncate + hash beyond MAX_IDTAG_LEN.
    const meta = buildRuntimeMetadata({
      ...enums,
      nmVersion: {
        label: 'nm760-on-myserver.corp.example.com',
        installDir: '/opt/nm760',
        version: '7.6',
      },
    });
    expect(meta.runtimeId).not.toContain('myserver');
    expect(meta.runtimeId).not.toContain('corp');
    expect(meta.runtimeId).not.toContain('example');
  });

  it('long labels sharing a prefix produce distinct runtimeIds (hash disambiguates)', () => {
    const a = buildRuntimeMetadata({
      ...enums,
      nmVersion: {
        label: 'nm760-server-alpha.corp.example.com',
        installDir: '/opt/nm760',
        version: '7.6',
      },
    });
    const b = buildRuntimeMetadata({
      ...enums,
      nmVersion: {
        label: 'nm760-server-beta.corp.example.com',
        installDir: '/opt/nm760',
        version: '7.6',
      },
    });
    expect(a.runtimeId).not.toBe(b.runtimeId);
  });

  it('runtimePath is a synthetic placeholder — installDir is privacy-sensitive and never surfaced', () => {
    const meta = buildRuntimeMetadata({
      ...enums,
      nmVersion: { label: 'default', installDir: '/home/alice/nm760', version: '7.6' },
    });
    // Must NOT contain the real installDir — Positron may surface
    // LanguageRuntimeMetadata to crash reporters / logs.
    expect(meta.runtimePath).not.toContain('/home/alice');
    expect(meta.runtimePath).not.toContain('/opt/nm760');
    // Should be anchored on the synthetic prefix + label-derived idTag.
    expect(meta.runtimePath).toBe('/_psn-managed/default/run/nmfe76');
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
