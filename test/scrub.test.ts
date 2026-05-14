import { describe, it, expect } from 'vitest';
import { scrubPrivate } from '../src/scrub';

describe('scrubPrivate', () => {
  it('redacts the Manager Location value but keeps the marker', () => {
    expect(scrubPrivate('Manager Location example-host//home/jane.doe@example.com/run1\n')).toBe(
      'Manager Location <redacted>\n',
    );
  });

  it('redacts License Registered to: value but keeps the marker', () => {
    expect(scrubPrivate('License Registered to: Acme Pharmaceuticals\n')).toBe(
      'License Registered to: <redacted>\n',
    );
  });

  it('redacts /home/<real-name>/ paths to /home/<user>/', () => {
    expect(scrubPrivate('working dir: /home/jane.doe/projects/m1\n')).toBe(
      'working dir: /home/<user>/projects/m1\n',
    );
  });

  it('redacts /Users/<real-name>/ paths to /Users/<user>/ on macOS-style paths', () => {
    expect(scrubPrivate('cwd /Users/jane.doe/work/run001.lst\n')).toBe(
      'cwd /Users/<user>/work/run001.lst\n',
    );
  });

  it('redacts an email-shaped path component as a path, not as an email (ordering contract)', () => {
    // Locks in the documented ordering: /home/<user>/ runs BEFORE the
    // email pattern, so an email inside a path becomes /home/<user>/...
    // not /home/<redacted-email>/...
    expect(scrubPrivate('cwd /home/jane.doe@example.com/run/m1\n')).toBe(
      'cwd /home/<user>/run/m1\n',
    );
  });

  it('replaces bare email tokens with <redacted-email>', () => {
    expect(scrubPrivate('contact: jane.doe@example.com for issues\n')).toBe(
      'contact: <redacted-email> for issues\n',
    );
  });

  it('handles a multi-line PsN/NONMEM banner end-to-end', () => {
    const raw =
      'Building NONMEM Executable\n' +
      'Starting MPI version of nonmem execution ...\n' +
      'Manager Location example-host//home/jane.doe@example.com/vrognas-nonmem/run1/modelfit_dir1/NM_run1\n' +
      'License Registered to: Acme Pharmaceuticals\n' +
      'Expiration Date:    14 JUL 2026\n';
    expect(scrubPrivate(raw)).toBe(
      'Building NONMEM Executable\n' +
        'Starting MPI version of nonmem execution ...\n' +
        'Manager Location <redacted>\n' +
        'License Registered to: <redacted>\n' +
        'Expiration Date:    14 JUL 2026\n',
    );
  });

  it('is idempotent (a second pass is a no-op)', () => {
    const raw =
      'Manager Location example-host//home/jane.doe@example.com/run\n' +
      'License Registered to: Acme\n' +
      'workdir /home/jane.doe/m1\n' +
      'reach jane.doe@example.com\n';
    const once = scrubPrivate(raw);
    expect(scrubPrivate(once)).toBe(once);
  });

  it('leaves text without leaks unchanged', () => {
    const clean = 'Starting NMTRAN\nFirst Order Conditional Estimation\nOFV: 4.531\n';
    expect(scrubPrivate(clean)).toBe(clean);
  });
});
