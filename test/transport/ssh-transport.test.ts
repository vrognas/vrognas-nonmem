import { describe, it, expect } from 'vitest';
import { __testing } from '../../src/transport/ssh-transport';

const { scrubHostname } = __testing;

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
