import { describe, it, expect } from 'vitest';
import {
  buildLstTooltip,
  pickBadge,
  makeDecoration,
} from '../../src/views/lst-decoration-provider';
import type { LstSummary } from '../../src/runtime/parse-lst';
import type { SumoSummary } from '../../src/runtime/parse-sumo';

const FULL_LST: LstSummary = {
  method: 'First Order Conditional Estimation with Interaction',
  methodShort: 'FOCE-INTER',
  sigDigits: 3.4,
  termination: 'SUCCESSFUL',
  terminationPhrase: 'MINIMIZATION SUCCESSFUL',
  terminationReason: null,
  etabar: [-0.012, 0.045],
  etaShrinkSd: [2.3, 4.7],
  epsShrinkSd: [3.5],
  eigenvalues: [0.9, 1.0, 1.1],
  acceptanceRate: null,
  numSigDigPerParam: [],
};

const FULL_SUMO: SumoSummary = {
  statuses: [
    { label: 'No rounding errors', level: 'OK', detail: [] },
    { label: 'Zero gradients found 1 times', level: 'WARNING', detail: [] },
    { label: 'Final zero gradients', level: 'ERROR', detail: [] },
  ],
  ofv: -638.795,
  totalRuntime: '0:00:01',
  estimationSeconds: 0.12,
  observations: 4,
  individuals: 2,
  conditionNumber: 324.5,
};

const BARE_LST: LstSummary = {
  method: null,
  methodShort: null,
  sigDigits: null,
  termination: null,
  terminationPhrase: null,
  terminationReason: null,
  etabar: [],
  etaShrinkSd: [],
  epsShrinkSd: [],
  eigenvalues: [],
  acceptanceRate: null,
  numSigDigPerParam: [],
};

describe('buildLstTooltip', () => {
  it('combines method+OFV on the head line, drops sumo OK statuses', () => {
    const t = buildLstTooltip(FULL_LST, FULL_SUMO);
    expect(t).not.toBeNull();
    // Head line: method · OFV.
    expect(t!.split('\n')[0]).toBe('FOCE-INTER · OFV = -638.795');
    // Meta line.
    expect(t!).toContain('runtime 0:00:01');
    expect(t!).toContain('sig-digits 3.4');
    expect(t!).toContain('cond');
    expect(t!).toContain('4 obs');
    expect(t!).toContain('2 subj');
    // Termination + sumo problem statuses.
    expect(t!).toContain('✓ MINIMIZATION SUCCESSFUL');
    expect(t!).toContain('⚠ Zero gradients found 1 times');
    expect(t!).toContain('✗ Final zero gradients');
    // Sumo OK statuses dropped — `No rounding errors` is OK-level.
    expect(t!).not.toContain('No rounding errors');
    // Plain text — no markdown bullets / bolding.
    expect(t!).not.toContain('**');
    expect(t!).not.toContain('\n- ');
  });

  it('falls back to lst-only when sumo is null', () => {
    const t = buildLstTooltip(FULL_LST, null);
    expect(t).not.toBeNull();
    expect(t!).toContain('FOCE-INTER');
    expect(t!).toContain('sig-digits 3.4');
    expect(t!).toContain('MINIMIZATION SUCCESSFUL');
    expect(t!).not.toContain('OFV');
    expect(t!).not.toContain('runtime');
  });

  it('inlines the termination reason with an em-dash on the phrase line', () => {
    const failed: LstSummary = {
      ...FULL_LST,
      termination: 'TERMINATED',
      terminationPhrase: 'MINIMIZATION TERMINATED',
      terminationReason: 'DUE TO ROUNDING ERRORS (ERROR=134)',
    };
    const t = buildLstTooltip(failed, FULL_SUMO);
    expect(t!).toContain('✗ MINIMIZATION TERMINATED — DUE TO ROUNDING ERRORS (ERROR=134)');
    // Reason should NOT also appear as a separate indented line.
    expect(t!).not.toContain('\n  DUE TO ROUNDING ERRORS');
  });

  it('collapses a multi-line termination reason into a single inline string', () => {
    const failed: LstSummary = {
      ...FULL_LST,
      termination: 'TERMINATED',
      terminationPhrase: 'MINIMIZATION TERMINATED',
      terminationReason: 'DUE TO ROUNDING ERRORS\n(ERROR=134)',
    };
    const t = buildLstTooltip(failed, null);
    expect(t!).toContain('✗ MINIMIZATION TERMINATED — DUE TO ROUNDING ERRORS (ERROR=134)');
  });

  it('returns null when both lst and sumo are empty (no signal worth surfacing)', () => {
    expect(buildLstTooltip(BARE_LST, null)).toBeNull();
  });
});

describe('pickBadge', () => {
  it('error in sumo statuses takes priority', () => {
    expect(pickBadge(FULL_LST, FULL_SUMO)).toBe('✗');
  });

  it('warning when sumo only has warnings, no errors', () => {
    const sumo: SumoSummary = {
      ...FULL_SUMO,
      statuses: [
        { label: 'OK', level: 'OK', detail: [] },
        { label: 'Some warning', level: 'WARNING', detail: [] },
      ],
    };
    expect(pickBadge(FULL_LST, sumo)).toBe('⚠');
  });

  it('success badge when minimization SUCCESSFUL and no sumo problems', () => {
    expect(pickBadge(FULL_LST, null)).toBe('✓');
  });

  it('undefined when no signal at all', () => {
    expect(pickBadge(BARE_LST, null)).toBeUndefined();
  });
});

describe('makeDecoration', () => {
  it('returns undefined when nothing useful surfaced', () => {
    expect(makeDecoration(BARE_LST, null)).toBeUndefined();
  });

  it('returns a decoration with badge + tooltip when data is present', () => {
    const d = makeDecoration(FULL_LST, FULL_SUMO);
    expect(d).toBeDefined();
    expect(d!.badge).toBe('✗');
    expect(d!.tooltip).toContain('FOCE-INTER');
    expect(d!.propagate).toBe(false);
  });
});
