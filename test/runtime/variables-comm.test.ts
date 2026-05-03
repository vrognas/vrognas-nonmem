import { describe, it, expect } from 'vitest';
import { mapParsedModelToVariables, resolveAccessKeyLine } from '../../src/runtime/variables-comm';
import type { NmtranParsedModel } from '../../src/nmtran-client';

function model(overrides: Partial<NmtranParsedModel> = {}): NmtranParsedModel {
  return {
    dataFile: 'd.csv',
    inputColumns: ['ID', 'TIME', 'DV'],
    thetas: [],
    omegas: [],
    sigmas: [],
    equations: [],
    ...overrides,
  };
}

describe('mapParsedModelToVariables', () => {
  it('emits one variable per THETA / OMEGA / SIGMA / equation, with values', () => {
    const vars = mapParsedModelToVariables(
      model({
        thetas: [{ index: 1, init: 1, fix: false }],
        omegas: [{ index: 1, value: 0.1, fix: false }],
        sigmas: [{ index: 1, value: 0.1, fix: false }],
        equations: [
          { name: 'Y', rhs: 'THETA(1) + ETA(1) + EPS(1)', block: '$PRED', line: 3, value: 1 },
        ],
      }),
    );

    expect(vars.map((v) => v.display_name)).toEqual(['THETA(1)', 'OMEGA(1,1)', 'SIGMA(1,1)', 'Y']);
    expect(vars.map((v) => v.display_value)).toEqual(['1', '0.1', '0.1', '1']);
    expect(vars.map((v) => v.display_type)).toEqual(['theta', 'omega', 'sigma', '$PRED']);
    // Parameters land in 'class' so Positron groups them under "CLASSES",
    // separating raw declarations from derived-equation values in "VALUES".
    expect(vars.map((v) => v.kind)).toEqual(['class', 'class', 'class', 'number']);
    expect(vars.every((v) => !v.has_children)).toBe(true);
  });

  it('marks rows with has_viewer=true (params + equations) when decl-line is known', () => {
    // Equations always carry a line. Parameters carry one when vscode-nmtran
    // >= 0.4.18; older releases omit the field and we degrade gracefully
    // (no false navigation).
    const vars = mapParsedModelToVariables(
      model({
        thetas: [{ index: 1, init: 1, fix: false, line: 10 }],
        omegas: [{ index: 1, value: 0.1, fix: false, line: 12 }],
        sigmas: [{ index: 1, value: 0.1, fix: false, line: 14 }],
        equations: [
          { name: 'Y', rhs: 'THETA(1)', block: '$PRED', line: 3, value: 1 },
          { name: 'K', rhs: 'LOG(CL)', block: '$PK', line: 5, value: undefined },
        ],
      }),
    );

    const byName = Object.fromEntries(vars.map((v) => [v.display_name, v.has_viewer]));
    expect(byName['THETA(1)']).toBe(true);
    expect(byName['OMEGA(1,1)']).toBe(true);
    expect(byName['SIGMA(1,1)']).toBe(true);
    expect(byName['Y']).toBe(true);
    expect(byName['K']).toBe(true);
  });

  it('falls back to has_viewer=false on parameters when vscode-nmtran < 0.4.18 omits line', () => {
    const vars = mapParsedModelToVariables(
      model({
        thetas: [{ index: 1, init: 1, fix: false }],
        omegas: [{ index: 1, value: 0.1, fix: false }],
        sigmas: [{ index: 1, value: 0.1, fix: false }],
      }),
    );
    expect(vars.every((v) => !v.has_viewer)).toBe(true);
  });
});

describe('resolveAccessKeyLine', () => {
  const m: NmtranParsedModel = {
    dataFile: 'd.csv',
    inputColumns: [],
    thetas: [
      { index: 1, init: 1, fix: false, line: 10 },
      { index: 2, init: 2, fix: false, line: 11 },
    ],
    omegas: [{ index: 1, value: 0.1, fix: false, line: 14 }],
    sigmas: [{ index: 1, value: 0.05, fix: false, line: 17 }],
    equations: [
      { name: 'Y', rhs: 'THETA(1)', block: '$PRED', line: 5, value: 1 },
      { name: 'CL', rhs: 'THETA(2)', block: '$PK', line: 7, value: 2 },
    ],
  };

  it('resolves equation names, THETA(n), OMEGA(n,n), SIGMA(n,n)', () => {
    expect(resolveAccessKeyLine(m, 'Y')).toBe(5);
    expect(resolveAccessKeyLine(m, 'CL')).toBe(7);
    expect(resolveAccessKeyLine(m, 'THETA(1)')).toBe(10);
    expect(resolveAccessKeyLine(m, 'THETA(2)')).toBe(11);
    expect(resolveAccessKeyLine(m, 'OMEGA(1,1)')).toBe(14);
    expect(resolveAccessKeyLine(m, 'SIGMA(1,1)')).toBe(17);
  });

  it('returns null for off-diagonal OMEGA / SIGMA, unknown indices, or garbage keys', () => {
    expect(resolveAccessKeyLine(m, 'OMEGA(1,2)')).toBeNull();
    expect(resolveAccessKeyLine(m, 'THETA(99)')).toBeNull();
    expect(resolveAccessKeyLine(m, 'SIGMA(99,99)')).toBeNull();
    expect(resolveAccessKeyLine(m, 'NOT_A_THING')).toBeNull();
  });

  it('returns null when a parameter has no tracked line (older vscode-nmtran)', () => {
    const stale: NmtranParsedModel = {
      ...m,
      thetas: [{ index: 1, init: 1, fix: false }],
    };
    expect(resolveAccessKeyLine(stale, 'THETA(1)')).toBeNull();
  });

  it('shows rhs as display_value when an equation cannot be evaluated (undefined value)', () => {
    const vars = mapParsedModelToVariables(
      model({
        equations: [{ name: 'K', rhs: 'LOG(CL)', block: '$PK', line: 2, value: undefined }],
      }),
    );

    const k = vars.find((v) => v.display_name === 'K')!;
    expect(k.display_value).toBe('LOG(CL)'); // unevaluable falls back to the rhs text
    expect(k.kind).toBe('string');
    expect(k.display_type).toBe('$PK'); // owning block, not the equation text
  });

  it('rounds noisy values to 3 decimal places in display_value', () => {
    const vars = mapParsedModelToVariables(
      model({
        thetas: [{ index: 1, init: 0.0676983, fix: false }],
        omegas: [{ index: 1, value: 4.2961234, fix: false }],
        equations: [{ name: 'Y', rhs: 'whatever', block: '$PRED', line: 1, value: 0.123456 }],
      }),
    );

    expect(vars[0].display_value).toBe('0.068');
    expect(vars[1].display_value).toBe('4.296');
    expect(vars[2].display_value).toBe('0.123');
  });

  it('marks FIX/lower/upper hints in display_value of THETA bounds', () => {
    const vars = mapParsedModelToVariables(
      model({
        thetas: [
          { index: 1, init: 1.5, lower: 0, upper: 10, fix: false },
          { index: 2, init: 2, fix: true },
        ],
      }),
    );

    expect(vars[0].display_value).toBe('1.5 (0..10)');
    expect(vars[1].display_value).toBe('2 (FIX)');
  });
});
