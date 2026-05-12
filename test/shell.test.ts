import { describe, it, expect, vi, afterEach } from 'vitest';
import { quote } from '../src/shell';

describe('quote', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSIX form: wraps in single quotes', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    expect(quote('run001.mod')).toBe(`'run001.mod'`);
  });

  it("POSIX form: escapes embedded apostrophes via '\\'' idiom", () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    expect(quote("o'brien.mod")).toBe(`'o'\\''brien.mod'`);
  });

  it('cmd.exe form: wraps in double quotes', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    expect(quote('run001.mod')).toBe('"run001.mod"');
  });

  it('cmd.exe form: escapes embedded double quotes by doubling', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    expect(quote('weird"name.mod')).toBe('"weird""name.mod"');
  });

  it('cmd.exe form: leaves apostrophes unchanged (they are literal in cmd)', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    expect(quote("o'brien.mod")).toBe(`"o'brien.mod"`);
  });

  it('handles empty input on both platforms', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    expect(quote('')).toBe(`''`);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    expect(quote('')).toBe('""');
  });
});
