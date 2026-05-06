import { describe, it, expect } from 'vitest';
import { isExecuteModelRun } from '../../src/runtime/runtime-session';

describe('isExecuteModelRun', () => {
  it('matches bare `execute run001.mod`', () => {
    expect(isExecuteModelRun('execute run001.mod')).toBe(true);
  });

  it("matches the canonical `cd '<dir>' && execute '<file>'` form", () => {
    expect(
      isExecuteModelRun(
        "cd '/work/run-dir' && execute -nm_version='default' -nm_output='ext,phi' 'run001.mod'",
      ),
    ).toBe(true);
  });

  it('matches with flags before the model file', () => {
    expect(isExecuteModelRun('execute -threads=2 -retries=1 run001.mod')).toBe(true);
  });

  it('does NOT match `execute -h` (no .mod argument)', () => {
    expect(isExecuteModelRun('execute -h')).toBe(false);
    expect(isExecuteModelRun('execute -version')).toBe(false);
  });

  it('does NOT match other PsN tools that take a .mod arg', () => {
    expect(isExecuteModelRun('sumo run001.lst')).toBe(false);
    expect(isExecuteModelRun('update_inits run001.mod')).toBe(false);
    expect(isExecuteModelRun('vpc -samples=200 run001.mod')).toBe(false);
  });

  it('does NOT match commands that mention `.mod` outside an execute clause', () => {
    expect(isExecuteModelRun('cat execute_log.mod')).toBe(false);
    expect(isExecuteModelRun('ls *.mod')).toBe(false);
    expect(isExecuteModelRun('grep run001.mod /etc/passwd')).toBe(false);
  });

  it('matches when execute follows a shell separator other than &&', () => {
    expect(isExecuteModelRun('cd /work; execute run001.mod')).toBe(true);
  });
});
