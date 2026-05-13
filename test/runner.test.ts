import { describe, it, expect } from 'vitest';
import { createCappedBuffer } from '../src/runner';

describe('createCappedBuffer', () => {
  it('returns input as-is when under cap', () => {
    const buf = createCappedBuffer(100);
    buf.append('hello');
    buf.append(' world');
    expect(buf.finalize()).toBe('hello world');
  });

  it('truncates at the cap boundary and appends a trailer', () => {
    const buf = createCappedBuffer(10);
    buf.append('hello');
    buf.append(' world!');
    const out = buf.finalize();
    expect(out.startsWith('hello worl')).toBe(true);
    expect(out).toContain('[output truncated at 10 chars]');
  });

  it('drops further appends silently after the cap', () => {
    const buf = createCappedBuffer(5);
    buf.append('abcdefghij');
    buf.append('more');
    const out = buf.finalize();
    expect(out.startsWith('abcde')).toBe(true);
    // Only one truncation trailer; subsequent appends are no-ops.
    expect((out.match(/output truncated/g) ?? []).length).toBe(1);
  });

  it('handles append that lands exactly on the cap (no truncation)', () => {
    const buf = createCappedBuffer(5);
    buf.append('hello');
    expect(buf.finalize()).toBe('hello');
  });
});
