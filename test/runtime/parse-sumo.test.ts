import { describe, it, expect } from 'vitest';
import { parseSumo } from '../../src/runtime/parse-sumo';

// Representative sumo output (verified empirically against PsN 5.3.1 +
// NONMEM 7.6.0 on qphcmp03 — see docs/psn-notes.md "sumo" section).
const FULL = `-----------------------------------------------------------------------

m.lst

Termination problems                                              [  ERROR  ]
No rounding errors                                                [    OK   ]
Zero gradients found 1 times                                      [ WARNING ]
Final zero gradients                                              [  ERROR  ]
Hessian not reset                                                 [    OK   ]
No parameter near boundary                                        [    OK   ]
No covariance step run.

Total run time for model (hours:min:sec):                  0:00:01
Estimation time for subproblem, sum over $EST (seconds):   0.12

Objective function value: 4.5310

Number of observation records: 4
Number of individuals: 2

           THETA                OMEGA      SIGMA
THETA1 ()    2.5  (........)

The relative standard errors for omega and sigma are reported on the approximate
standard deviation scale (SE/variance estimate)/2.
-----------------------------------------------------------------------
`;

describe('parseSumo', () => {
  it('extracts status lines, OFV, runtime, sample sizes from a representative output', () => {
    const summary = parseSumo(FULL);
    expect(summary).not.toBeNull();
    expect(summary!.ofv).toBeCloseTo(4.531, 3);
    expect(summary!.totalRuntime).toBe('0:00:01');
    expect(summary!.estimationSeconds).toBeCloseTo(0.12, 2);
    expect(summary!.observations).toBe(4);
    expect(summary!.individuals).toBe(2);
    expect(summary!.statuses).toEqual([
      { label: 'Termination problems', level: 'ERROR', detail: [] },
      { label: 'No rounding errors', level: 'OK', detail: [] },
      { label: 'Zero gradients found 1 times', level: 'WARNING', detail: [] },
      { label: 'Final zero gradients', level: 'ERROR', detail: [] },
      { label: 'Hessian not reset', level: 'OK', detail: [] },
      { label: 'No parameter near boundary', level: 'OK', detail: [] },
    ]);
    // Condition number isn't in the FULL fixture (no $COV), so it's null.
    expect(summary!.conditionNumber).toBeNull();
  });

  it('parses condition number when sumo emits one ($COV step ran with cond. nr.)', () => {
    // Real-world sumo output uses `Condition number: <value>` (colon).
    // There's ALSO a status row `Condition number  [   OK   ]` which
    // appears when $COV ran clean — that maps to a status, not a value.
    const text = `-----------------------------------------------------------------------
m.lst
No rounding errors                                                [    OK   ]
Condition number                                                  [    OK   ]
Covariance time for subproblem, sum over $EST (seconds):   10.77
Condition number: 420.3
Objective function value: -638.7950
-----------------------------------------------------------------------
`;
    const summary = parseSumo(text);
    expect(summary!.conditionNumber).toBeCloseTo(420.3, 1);
    expect(summary!.ofv).toBeCloseTo(-638.795, 3);
    // The status row also captured (so we can show "Condition number OK"
    // alongside other badges).
    expect(summary!.statuses.some((s) => s.label === 'Condition number')).toBe(true);
  });

  it('returns null on garbage input (no OFV, no statuses, no runtime)', () => {
    expect(parseSumo('')).toBeNull();
    expect(parseSumo('not sumo output\nanother line\n')).toBeNull();
  });

  it('captures indented detail lines under a status row (e.g. correlation pairs under WARNING)', () => {
    const text = `m.lst
No rounding errors                                                [    OK   ]
Large correlations between parameter estimates found              [ WARNING ]
        OMEGA(2,2) - OMEGA(2,1)    -0.939
        OMEGA(3,1) - OMEGA(2,1)    -0.912
        OMEGA(3,2) - OMEGA(2,2)    -0.968
        OMEGA(3,3) - OMEGA(3,2)     -0.91
Hessian not reset                                                 [    OK   ]
Objective function value: 100
`;
    const summary = parseSumo(text);
    const warn = summary!.statuses.find((s) => s.label.startsWith('Large correlations'));
    expect(warn).toBeDefined();
    expect(warn!.level).toBe('WARNING');
    expect(warn!.detail).toEqual([
      'OMEGA(2,2) - OMEGA(2,1)    -0.939',
      'OMEGA(3,1) - OMEGA(2,1)    -0.912',
      'OMEGA(3,2) - OMEGA(2,2)    -0.968',
      'OMEGA(3,3) - OMEGA(3,2)     -0.91',
    ]);
    // Detail bounded — does NOT bleed into the next status row.
    const ok = summary!.statuses.find((s) => s.label === 'Hessian not reset');
    expect(ok!.detail).toEqual([]);
  });

  it('detail is empty for plain status rows with nothing under them', () => {
    const summary = parseSumo(FULL);
    for (const s of summary!.statuses) expect(s.detail).toEqual([]);
  });

  it("ignores 'No covariance step run.' (no bracket → not a status row)", () => {
    const text = `m.lst
No rounding errors                                                [    OK   ]
No covariance step run.
Objective function value: 100
`;
    const summary = parseSumo(text);
    expect(summary!.statuses).toEqual([{ label: 'No rounding errors', level: 'OK', detail: [] }]);
  });
});
