import { describe, it, expect } from 'vitest';
import { __testing } from '../src/ssh-transport';

const { scrubHostname } = __testing;

describe('scrubHostname', () => {
  it('redacts the literal host from a typical DNS error message', () => {
    expect(scrubHostname('getaddrinfo ENOTFOUND qphcmp03', 'qphcmp03')).toBe(
      'getaddrinfo ENOTFOUND <host>',
    );
  });

  it('redacts every occurrence of the host', () => {
    expect(scrubHostname('connect ECONNREFUSED qphcmp03:22 (qphcmp03)', 'qphcmp03')).toBe(
      'connect ECONNREFUSED <host>:22 (<host>)',
    );
  });

  it('passes empty-host inputs through (defensive: never accidentally redact "")', () => {
    expect(scrubHostname('arbitrary message', '')).toBe('arbitrary message');
  });

  it('does not redact substrings that happen to look like the host', () => {
    // exact match only — no substring partial expansion. "host" should not match "ahosting".
    expect(scrubHostname('ahosting service', 'host')).toBe('a<host>ing service');
    // ^ exact-substring is the documented behaviour. If we ever need word-boundary
    // matching, change scrubHostname to use a regex with \b.
  });
});
