import { describe, it, expect } from 'vitest';
import { mapParsedModelToVariables } from '../../src/runtime/variables-comm';
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

  it('marks equation rows with has_viewer=true so double-click triggers a `view` RPC', () => {
    // Parameters (THETA/OMEGA/SIGMA) don't carry decl-line tracking yet, so
    // they stay non-navigable. Equations always have a `line` field, so we
    // enable the viewer so Positron's frontend opens a `view` RPC on
    // double-click; the runtime-session handler routes that to the editor.
    const vars = mapParsedModelToVariables(
      model({
        thetas: [{ index: 1, init: 1, fix: false }],
        omegas: [{ index: 1, value: 0.1, fix: false }],
        sigmas: [{ index: 1, value: 0.1, fix: false }],
        equations: [
          { name: 'Y', rhs: 'THETA(1)', block: '$PRED', line: 3, value: 1 },
          { name: 'K', rhs: 'LOG(CL)', block: '$PK', line: 5, value: undefined },
        ],
      }),
    );

    const byName = Object.fromEntries(vars.map((v) => [v.display_name, v.has_viewer]));
    expect(byName['THETA(1)']).toBe(false);
    expect(byName['OMEGA(1,1)']).toBe(false);
    expect(byName['SIGMA(1,1)']).toBe(false);
    expect(byName['Y']).toBe(true);
    expect(byName['K']).toBe(true);
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
