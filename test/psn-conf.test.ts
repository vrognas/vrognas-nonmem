import { describe, it, expect } from 'vitest';
import { fetchNmVersions, parseNmVersionsOutput, PSN_CONF_DUMP_SCRIPT } from '../src/psn-conf';
import type { CommandResult, Runner } from '../src/runner';

class FakeRunner implements Runner {
  readonly runs: { command: string; cwd: string | undefined }[] = [];
  readonly results: CommandResult[] = [];

  async run(command: string, cwd?: string): Promise<CommandResult> {
    this.runs.push({ command, cwd });
    return this.results.shift() ?? { code: 0, stdout: '', stderr: '' };
  }
}

describe('parseNmVersionsOutput', () => {
  it('parses a single-entry dump', () => {
    expect(parseNmVersionsOutput('default\t/opt/nm760,7.6\n')).toEqual([
      { label: 'default', installDir: '/opt/nm760', version: '7.6' },
    ]);
  });

  it('parses multi-entry output and sorts default first, then alphabetic', () => {
    // Mirrors the actual qphcmp03 dump: 74, 75, default → default, 74, 75.
    const out = '74\t/opt/nm743,7.4\n75\t/opt/nm751,7.5\ndefault\t/opt/nm760,7.6\n';
    expect(parseNmVersionsOutput(out)).toEqual([
      { label: 'default', installDir: '/opt/nm760', version: '7.6' },
      { label: '74', installDir: '/opt/nm743', version: '7.4' },
      { label: '75', installDir: '/opt/nm751', version: '7.5' },
    ]);
  });

  it('skips entries whose label contains whitespace (PsN rejects them at runtime)', () => {
    expect(parseNmVersionsOutput('n m 76\t/opt/nm760,7.6\ndefault\t/opt/nm760,7.6\n')).toEqual([
      { label: 'default', installDir: '/opt/nm760', version: '7.6' },
    ]);
  });

  it('returns [] for empty / whitespace / malformed input without throwing', () => {
    expect(parseNmVersionsOutput('')).toEqual([]);
    expect(parseNmVersionsOutput('\n\n   \n')).toEqual([]);
    // Missing tab, missing comma, empty pieces — all skipped silently.
    expect(parseNmVersionsOutput('label-only\n\tno-label,1.0\nlabel\t,1.0\nlabel\tdir,\n')).toEqual(
      [],
    );
  });
});

describe('fetchNmVersions', () => {
  it('runs the bash script via the Runner and parses its stdout', async () => {
    const runner = new FakeRunner();
    runner.results.push({
      code: 0,
      stdout: 'default\t/opt/nm760,7.6\n',
      stderr: '',
    });
    const got = await fetchNmVersions(runner);
    expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0].command).toBe(PSN_CONF_DUMP_SCRIPT);
    expect(got).toEqual([{ label: 'default', installDir: '/opt/nm760', version: '7.6' }]);
  });

  it('throws with the stderr message when the script exits non-zero', async () => {
    const runner = new FakeRunner();
    runner.results.push({
      code: 1,
      stdout: '',
      stderr: 'psn: command not found\n',
    });
    await expect(fetchNmVersions(runner)).rejects.toThrow(/psn: command not found/);
  });
});
