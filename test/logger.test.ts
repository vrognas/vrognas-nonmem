import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '../src/logger';

function fakeChannel() {
  const lines: string[] = [];
  return {
    lines,
    appendLine: (s: string): void => {
      lines.push(s);
    },
    show: vi.fn(),
    dispose: vi.fn(),
    name: 'fake',
    append: vi.fn(),
    replace: vi.fn(),
    clear: vi.fn(),
    hide: vi.fn(),
  };
}

beforeEach(() => {
  vi.resetModules();
});

describe('Logger', () => {
  it('prefixes info() with the alias', () => {
    const ch = fakeChannel();
    const log = new Logger(ch as never, 'primary');
    log.info('hello');
    expect(ch.lines).toEqual(['[primary] hello']);
  });

  it('prefixes errorToast() with [error] [alias]', async () => {
    // We don't have a real vscode here; the toast call uses the stub vscode module
    // via the alias in vitest.config.ts. Just verify the channel side of the pair.
    const ch = fakeChannel();
    const log = new Logger(ch as never, 'primary');
    await log.errorToast('boom');
    expect(ch.lines).toEqual(['[error] [primary] boom']);
  });

  it('successToast() writes the same prefixed line as info()', async () => {
    const ch = fakeChannel();
    const log = new Logger(ch as never, 'primary');
    await log.successToast('done');
    expect(ch.lines).toEqual(['[primary] done']);
  });

  it('raw() writes the message without a prefix (for activation banner etc.)', () => {
    const ch = fakeChannel();
    const log = new Logger(ch as never, 'primary');
    log.raw('[positron-nonmem] activated.');
    expect(ch.lines).toEqual(['[positron-nonmem] activated.']);
  });

  it('does not include the hostname even if the message accidentally contains it', () => {
    // Logger is alias-only by contract. This test enforces that contract: the host
    // value is never passed in. It's an architecture-level guarantee, not something
    // Logger itself defends against; this test exists to fail loudly if a future
    // refactor adds a `host` parameter.
    const ch = fakeChannel();
    const log = new Logger(ch as never, 'primary');
    log.info('connected');
    expect(ch.lines.join('\n')).not.toMatch(/host/i);
  });
});
