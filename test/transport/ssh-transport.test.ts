import { describe, it, expect } from 'vitest';
import { __testing } from '../../src/transport/ssh-transport';

const { scrubHostname, buildScpPutArgs, buildScpGetArgs, quoteRemotePath, lastLine } = __testing;

describe('scrubHostname', () => {
  it('redacts the literal host from a typical DNS error message', () => {
    expect(
      scrubHostname('getaddrinfo ENOTFOUND host.example.invalid', 'host.example.invalid'),
    ).toBe('getaddrinfo ENOTFOUND <host>');
  });

  it('redacts every occurrence of the host', () => {
    expect(
      scrubHostname(
        'connect ECONNREFUSED host.example.invalid:22 (host.example.invalid)',
        'host.example.invalid',
      ),
    ).toBe('connect ECONNREFUSED <host>:22 (<host>)');
  });

  it('passes empty-host inputs through (defensive: never accidentally redact "")', () => {
    expect(scrubHostname('arbitrary message', '')).toBe('arbitrary message');
  });

  it('does not redact substrings that happen to look like the host', () => {
    expect(scrubHostname('ahosting service', 'host')).toBe('a<host>ing service');
  });
});

describe('scp argv builders', () => {
  it('putFile uses BatchMode=yes and <alias>:<remote> destination', () => {
    expect(buildScpPutArgs('primary', '/local/m.mod', '~/positron-nonmem/pn-1/m.mod')).toEqual([
      '-o',
      'BatchMode=yes',
      '/local/m.mod',
      'primary:~/positron-nonmem/pn-1/m.mod',
    ]);
  });

  it('getFile uses BatchMode=yes and <alias>:<remote> source', () => {
    expect(buildScpGetArgs('primary', '~/positron-nonmem/pn-1/m.lst', '/local/m.lst')).toEqual([
      '-o',
      'BatchMode=yes',
      'primary:~/positron-nonmem/pn-1/m.lst',
      '/local/m.lst',
    ]);
  });
});

describe('quoteRemotePath', () => {
  // Bug regression: single-quoting a `~/...` path made bash treat the
  // tilde as literal — `cat > '~/positron-nonmem/.../manifest.json'`
  // failed with "No such file or directory" because `~` doesn't expand
  // inside single quotes.

  it('expands leading ~/ via $HOME with the rest single-quoted', () => {
    expect(quoteRemotePath('~/positron-nonmem/pn-1/manifest.json')).toBe(
      `"$HOME"/'positron-nonmem/pn-1/manifest.json'`,
    );
  });

  it('handles bare ~', () => {
    expect(quoteRemotePath('~')).toBe('"$HOME"');
  });

  it('single-quotes absolute paths with no expansion', () => {
    expect(quoteRemotePath('/tmp/run/m.lst')).toBe(`'/tmp/run/m.lst'`);
  });

  it('escapes single quotes inside the path (bash close-and-reopen idiom)', () => {
    expect(quoteRemotePath(`/tmp/o'brien/m.lst`)).toBe(`'/tmp/o'\\''brien/m.lst'`);
  });

  it('escapes single quotes inside the post-~ portion', () => {
    expect(quoteRemotePath(`~/o'brien`)).toBe(`"$HOME"/'o'\\''brien'`);
  });
});

describe('lastLine', () => {
  // Bug regression: ssh stderr can contain VisualHostKey banner art
  // followed by the real error. We surface only the last non-empty line
  // so error toasts don't include the fingerprint art.
  it('returns the last non-empty trimmed line', () => {
    const stderr = [
      'Host key fingerprint is SHA256:abc',
      '+--[ED25519 256]--+',
      '|. . o E .|',
      '+----[SHA256]-----+',
      'bash: line 1: ~/path: No such file or directory',
    ].join('\n');
    expect(lastLine(stderr)).toBe('bash: line 1: ~/path: No such file or directory');
  });

  it('returns "" for empty / whitespace-only input', () => {
    expect(lastLine('')).toBe('');
    expect(lastLine('  \n\n  ')).toBe('');
  });
});
