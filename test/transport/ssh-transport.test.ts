import { describe, it, expect } from 'vitest';
import { __testing } from '../../src/transport/ssh-transport';

const { scrubHostname, buildScpPutArgs, buildScpGetArgs } = __testing;

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
