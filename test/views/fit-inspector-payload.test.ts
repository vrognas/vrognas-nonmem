import { describe, it, expect } from 'vitest';
import { buildInspectorPayload } from '../../src/views/fit-inspector-payload';
import type { NmtranParsedModel } from '../../src/nmtran-client';
import type { ExtEstimates } from '../../src/runtime/parse-ext-fit';

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

function fit(
  finals: Record<string, number>,
  ses: Record<string, number> = {},
  inits: Record<string, number> = {},
): ExtEstimates {
  return {
    ofv: -638.795,
    inits: new Map(Object.entries(inits)),
    finals: new Map(Object.entries(finals)),
    standardErrors: new Map(Object.entries(ses)),
  };
}

describe('buildInspectorPayload', () => {
  it('returns null when model is null (no editor / unknown file)', () => {
    expect(buildInspectorPayload(null)).toBeNull();
  });

  it('mod-mode (no fit): every row has init populated and final/se null; no summary', () => {
    const payload = buildInspectorPayload(
      model({
        thetas: [
          { index: 1, init: 1.5, lower: 0, upper: 10, fix: false, line: 10 },
          { index: 2, init: 2, fix: true, line: 11 },
        ],
        omegas: [{ index: 1, value: 0.1, fix: false, line: 14 }],
        sigmas: [{ index: 1, value: 1, fix: false, line: 17 }],
      }),
    );

    expect(payload).not.toBeNull();
    expect(payload!.summary).toBeNull();
    expect(payload!.runNotes).toBeNull();
    expect(payload!.diagnostics).toBeNull();
    expect(payload!.thetas).toEqual([
      {
        index: 1,
        name: 'THETA(1)',
        label: null,
        lower: 0,
        init: 1.5,
        upper: 10,
        final: null,
        se: null,
        rse: null,
        fixed: false,
        numSigDig: null,
        declLine: 10,
        boundary: null,
      },
      {
        index: 2,
        name: 'THETA(2)',
        label: null,
        lower: null,
        init: 2,
        upper: null,
        final: null,
        se: null,
        rse: null,
        fixed: true,
        numSigDig: null,
        declLine: 11,
        boundary: null,
      },
    ]);
    expect(payload!.omegas[0]).toMatchObject({
      name: 'OMEGA(1,1)',
      lower: null,
      init: 0.1,
      upper: null,
      final: null,
      se: null,
      fixed: false,
      declLine: 14,
    });
    expect(payload!.sigmas[0]).toMatchObject({
      name: 'SIGMA(1,1)',
      lower: null,
      init: 1,
      upper: null,
      final: null,
      se: null,
      declLine: 17,
    });
  });

  it('lst-mode (with fit): final + se populated by access-key match; summary carries OFV + lst basename', () => {
    const payload = buildInspectorPayload(
      model({
        thetas: [{ index: 1, init: 1.5, lower: 0, upper: 10, fix: false, line: 10 }],
        omegas: [{ index: 1, value: 0.1, fix: false, line: 14 }],
        sigmas: [{ index: 1, value: 1, fix: false, line: 17 }],
      }),
      {
        lstPath: '/work/run001.lst',
        fit: fit(
          { 'THETA(1)': 2.523, 'OMEGA(1,1)': 0.184, 'SIGMA(1,1)': 0.041 },
          { 'THETA(1)': 0.123, 'OMEGA(1,1)': 0.025, 'SIGMA(1,1)': 0.008 },
        ),
      },
    );

    expect(payload!.summary).toEqual({
      title: 'run001.lst',
      ofv: -638.795,
      sumo: null,
      lst: null,
    });
    expect(payload!.thetas[0]).toMatchObject({ init: 1.5, final: 2.523, se: 0.123 });
    expect(payload!.omegas[0]).toMatchObject({ init: 0.1, final: 0.184, se: 0.025 });
    expect(payload!.sigmas[0]).toMatchObject({ init: 1, final: 0.041, se: 0.008 });
  });

  it('emits off-diagonal OMEGA/SIGMA rows from fit when present, sorted lower-triangular', () => {
    const payload = buildInspectorPayload(
      model({
        // 3-element BLOCK matrix: vscode-nmtran exposes the diagonals as
        // OMEGA(1,1) / OMEGA(2,2) / OMEGA(3,3); the off-diagonals
        // OMEGA(2,1), OMEGA(3,1), OMEGA(3,2) only appear in the .ext.
        omegas: [
          { index: 1, value: 0.1, fix: false, line: 10 },
          { index: 2, value: 0.2, fix: false, line: 11 },
          { index: 3, value: 0.3, fix: false, line: 12 },
        ],
      }),
      {
        lstPath: '/work/run001.lst',
        fit: fit(
          {
            'OMEGA(1,1)': 0.11,
            'OMEGA(2,1)': 0.05,
            'OMEGA(2,2)': 0.22,
            'OMEGA(3,1)': 0.04,
            'OMEGA(3,2)': 0.06,
            'OMEGA(3,3)': 0.33,
          },
          {
            'OMEGA(2,1)': 0.01,
          },
        ),
      },
    );

    expect(payload!.omegas.map((o) => o.name)).toEqual([
      'OMEGA(1,1)',
      'OMEGA(2,1)',
      'OMEGA(2,2)',
      'OMEGA(3,1)',
      'OMEGA(3,2)',
      'OMEGA(3,3)',
    ]);
    // Off-diagonal: init/declLine null when fit.inits omits the entry;
    // final/se from .ext are populated.
    const offDiag21 = payload!.omegas.find((o) => o.name === 'OMEGA(2,1)')!;
    expect(offDiag21.init).toBeNull();
    expect(offDiag21.declLine).toBeNull();
    expect(offDiag21.final).toBeCloseTo(0.05, 5);
    expect(offDiag21.se).toBeCloseTo(0.01, 5);
    // Diagonal: init populated from vscode-nmtran.
    const diag22 = payload!.omegas.find((o) => o.name === 'OMEGA(2,2)')!;
    expect(diag22.init).toBe(0.2);
    expect(diag22.final).toBeCloseTo(0.22, 5);
  });

  it('computes RSE matching sumo: SE/|val| for THETA, (SE/|val|)/2 for OMEGA/SIGMA', () => {
    const payload = buildInspectorPayload(
      model({
        thetas: [{ index: 1, init: 1, fix: false }],
        omegas: [{ index: 1, value: 0.1, fix: false }],
        sigmas: [{ index: 1, value: 1, fix: false }],
      }),
      {
        lstPath: '/work/run001.lst',
        fit: fit(
          { 'THETA(1)': 0.986, 'OMEGA(1,1)': 0.1924, 'SIGMA(1,1)': 0.502 },
          // Absolute SE_var values: pick numbers that yield round RSE_SD
          // for assertion — THETA RSE = 0.0089 / 0.986 ≈ 0.009037;
          // OMEGA RSE_SD = 0.0256 / 0.1924 / 2 ≈ 0.06658.
          { 'THETA(1)': 0.0089, 'OMEGA(1,1)': 0.0256, 'SIGMA(1,1)': 0.003585 },
        ),
      },
    );
    expect(payload!.thetas[0].rse).toBeCloseTo(0.009037, 4);
    expect(payload!.omegas[0].rse).toBeCloseTo(0.0666, 3);
    expect(payload!.sigmas[0].rse).toBeCloseTo(0.00357, 4);
  });

  it('rse is null when final is 0 / SE missing (no division-by-zero noise)', () => {
    const payload = buildInspectorPayload(
      model({
        thetas: [{ index: 1, init: 0, fix: false }],
        omegas: [{ index: 1, value: 0.1, fix: false }],
      }),
      {
        lstPath: '/work/run001.lst',
        fit: fit({ 'THETA(1)': 0, 'OMEGA(1,1)': 0.1 }, { 'THETA(1)': 0.5 }),
      },
    );
    expect(payload!.thetas[0].rse).toBeNull(); // final = 0 → null
    expect(payload!.omegas[0].rse).toBeNull(); // SE missing → null
  });

  it('rse is null when SE = 0 (FIXED parameter — no inference, NOT "0% RSE")', () => {
    // NONMEM emits SE=0 for FIXED params even when $COV ran. Returning
    // 0% RSE makes them look infinitely precise (the opposite of the
    // truth — "no inference attempted"). One non-FIX entry keeps the
    // SE map non-empty so parseExtFit's row-level all-zero detection
    // doesn't drop everything.
    const payload = buildInspectorPayload(
      model({
        thetas: [
          { index: 1, init: 1.0, fix: true },
          { index: 2, init: 2.5, fix: false },
        ],
        omegas: [
          { index: 1, value: 0.1, fix: true },
          { index: 2, value: 0.2, fix: false },
        ],
      }),
      {
        lstPath: '/work/run001.lst',
        fit: fit(
          { 'THETA(1)': 1.0, 'THETA(2)': 2.5, 'OMEGA(1,1)': 0.1, 'OMEGA(2,2)': 0.2 },
          { 'THETA(1)': 0, 'THETA(2)': 0.123, 'OMEGA(1,1)': 0, 'OMEGA(2,2)': 0.025 },
        ),
      },
    );
    expect(payload!.thetas[0].rse).toBeNull();
    expect(payload!.thetas[1].rse).toBeCloseTo(0.0492, 3);
    expect(payload!.omegas[0].rse).toBeNull();
    expect(payload!.omegas[1].rse).toBeCloseTo(0.0625, 3);
  });

  it('does not emit off-diagonals in mod-mode (no fit means no source for them)', () => {
    const payload = buildInspectorPayload(
      model({
        omegas: [
          { index: 1, value: 0.1, fix: false, line: 10 },
          { index: 2, value: 0.2, fix: false, line: 11 },
        ],
      }),
    );
    expect(payload!.omegas.map((o) => o.name)).toEqual(['OMEGA(1,1)', 'OMEGA(2,2)']);
  });

  it('decl with no matching .ext column → final stays null (model edited post-run)', () => {
    const payload = buildInspectorPayload(
      model({
        thetas: [
          { index: 1, init: 1, fix: false },
          { index: 2, init: 5, fix: false }, // not in fit
        ],
      }),
      { lstPath: '/work/run001.lst', fit: fit({ 'THETA(1)': 2.0 }, { 'THETA(1)': 0.1 }) },
    );

    expect(payload!.thetas[0]).toMatchObject({ init: 1, final: 2.0, se: 0.1 });
    expect(payload!.thetas[1]).toMatchObject({ init: 5, final: null, se: null });
  });

  it('threads vscode-nmtran inline `comment` through to the row `label` (Pirana convention)', () => {
    const payload = buildInspectorPayload(
      model({
        thetas: [
          { index: 1, init: 4.79, fix: false, line: 3, comment: 'CL' },
          { index: 2, init: 90.2, fix: false, line: 4 }, // no comment
        ],
        omegas: [{ index: 1, value: 0.1, fix: false, line: 7, comment: 'IIV CL' }],
        sigmas: [{ index: 1, value: 1, fix: false, line: 10, comment: 'PAdditive' }],
      }),
    );
    expect(payload!.thetas.map((t) => t.label)).toEqual(['CL', null]);
    expect(payload!.omegas[0].label).toBe('IIV CL');
    expect(payload!.sigmas[0].label).toBe('PAdditive');
  });

  it('off-diagonal OMEGA/SIGMA rows have label=null (no .mod source for BLOCK off-diags)', () => {
    const payload = buildInspectorPayload(
      model({
        omegas: [{ index: 1, value: 0.1, fix: false, line: 5, comment: 'IIV CL' }],
      }),
      {
        lstPath: '/work/run001.lst',
        fit: fit({ 'OMEGA(1,1)': 0.1, 'OMEGA(2,1)': 0.05, 'OMEGA(2,2)': 0.2 }),
      },
    );
    const offDiag = payload!.omegas.find((r) => r.name === 'OMEGA(2,1)');
    expect(offDiag).toBeDefined();
    expect(offDiag!.label).toBeNull();
  });

  describe('boundary detection', () => {
    it("flags 'lower' when final === lower (estimator stuck at the lower bound)", () => {
      const payload = buildInspectorPayload(
        model({ thetas: [{ index: 1, init: 0.5, lower: 0, upper: 10, fix: false }] }),
        { lstPath: '/work/run001.lst', fit: fit({ 'THETA(1)': 0 }) },
      );
      expect(payload!.thetas[0].boundary).toBe('lower');
    });

    it("flags 'upper' when final === upper (estimator stuck at the upper bound)", () => {
      const payload = buildInspectorPayload(
        model({ thetas: [{ index: 1, init: 5, lower: 0, upper: 10, fix: false }] }),
        { lstPath: '/work/run001.lst', fit: fit({ 'THETA(1)': 10 }) },
      );
      expect(payload!.thetas[0].boundary).toBe('upper');
    });

    it('null when both bounds are null (no comparison possible)', () => {
      const payload = buildInspectorPayload(
        model({ thetas: [{ index: 1, init: 5, fix: false }] }),
        { lstPath: '/work/run001.lst', fit: fit({ 'THETA(1)': 5 }) },
      );
      expect(payload!.thetas[0].boundary).toBeNull();
    });

    it('null when final is interior (neither bound matches)', () => {
      const payload = buildInspectorPayload(
        model({ thetas: [{ index: 1, init: 5, lower: 0, upper: 10, fix: false }] }),
        { lstPath: '/work/run001.lst', fit: fit({ 'THETA(1)': 4.79 }) },
      );
      expect(payload!.thetas[0].boundary).toBeNull();
    });

    it("FIX parameter at the bound is NOT flagged (fixed-by-design isn't a convergence concern)", () => {
      const payload = buildInspectorPayload(
        model({ thetas: [{ index: 1, init: 0, lower: 0, upper: 10, fix: true }] }),
        { lstPath: '/work/run001.lst', fit: fit({ 'THETA(1)': 0 }) },
      );
      expect(payload!.thetas[0].boundary).toBeNull();
    });

    it('mod-mode (no fit, final=null) → boundary always null', () => {
      const payload = buildInspectorPayload(
        model({ thetas: [{ index: 1, init: 0, lower: 0, upper: 10, fix: false }] }),
      );
      expect(payload!.thetas[0].boundary).toBeNull();
    });

    it('OMEGA / SIGMA never flagged (vscode-nmtran does not expose their bounds yet)', () => {
      const payload = buildInspectorPayload(
        model({
          omegas: [{ index: 1, value: 0, fix: false }],
          sigmas: [{ index: 1, value: 1, fix: false }],
        }),
        {
          lstPath: '/work/run001.lst',
          fit: fit({ 'OMEGA(1,1)': 0, 'SIGMA(1,1)': 1 }),
        },
      );
      expect(payload!.omegas[0].boundary).toBeNull();
      expect(payload!.sigmas[0].boundary).toBeNull();
    });
  });
});
