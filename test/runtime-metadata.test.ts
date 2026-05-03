import { describe, it, expect } from 'vitest';
import { buildRuntimeMetadata } from '../src/runtime/runtime-metadata';

const enums = {
  startupBehavior: 'explicit' as never,
  sessionLocation: 'workspace' as never,
};

describe('buildRuntimeMetadata', () => {
  it('uses a stable runtimeId so session restoration works across IDE restarts', () => {
    const a = buildRuntimeMetadata({ ...enums, nonmemVersion: '7.6.0' });
    const b = buildRuntimeMetadata({ ...enums, nonmemVersion: '7.6.0' });
    expect(a.runtimeId).toBe(b.runtimeId);
    expect(a.runtimeId).toBe('positron-nonmem');
  });

  it('targets the nmtran languageId (companion to vscode-nmtran)', () => {
    const meta = buildRuntimeMetadata({ ...enums, nonmemVersion: '7.6.0' });
    expect(meta.languageId).toBe('nmtran');
  });

  it('renders the NONMEM version in the display name', () => {
    const meta = buildRuntimeMetadata({ ...enums, nonmemVersion: '7.6.0' });
    expect(meta.runtimeName).toBe('NONMEM 7.6.0');
    expect(meta.languageVersion).toBe('7.6.0');
  });

  it('includes the inlined SVG icon (base64-encoded)', () => {
    const meta = buildRuntimeMetadata({ ...enums, nonmemVersion: '7.6.0' });
    expect(meta.base64EncodedIconSvg).toBeTruthy();
    expect(Buffer.from(meta.base64EncodedIconSvg!, 'base64').toString()).toContain('<svg');
  });
});
