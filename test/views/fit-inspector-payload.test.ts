import { describe, it, expect } from 'vitest';
import { buildInspectorPayload } from '../../src/views/fit-inspector-payload';
import type { NmtranParsedModel } from '../../src/nmtran-client';
import type { ExtEstimates } from '../../src/runtime/parse-ext-fit';
import { mockLst } from '../__helpers__/mock-lst';

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
  extras: {
    finalsStdcorr?: Record<string, number>;
    standardErrorsStdcorr?: Record<string, number>;
    fixedFlags?: Record<string, boolean>;
    terminationCodes?: number[];
  } = {},
): ExtEstimates {
  return {
    ofv: -638.795,
    inits: new Map(Object.entries(inits)),
    finals: new Map(Object.entries(finals)),
    standardErrors: new Map(Object.entries(ses)),
    finalsStdcorr: new Map(Object.entries(extras.finalsStdcorr ?? {})),
    standardErrorsStdcorr: new Map(Object.entries(extras.standardErrorsStdcorr ?? {})),
    fixedFlags: new Map(Object.entries(extras.fixedFlags ?? {})),
    terminationCodes: extras.terminationCodes ?? [],
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
        impliedInit: false,
        upper: 10,
        final: null,
        finalStdcorr: null,
        se: null,
        seStdcorr: null,
        rse: null,
        rseStdcorr: null,
        fixed: false,
        numSigDig: null,
        declLine: 10,
        boundary: null,
        priorValue: null,
        priorVariance: null,
        priorDf: null,
      },
      {
        index: 2,
        name: 'THETA(2)',
        label: null,
        lower: null,
        init: 2,
        impliedInit: false,
        upper: null,
        final: null,
        finalStdcorr: null,
        se: null,
        seStdcorr: null,
        rse: null,
        rseStdcorr: null,
        fixed: true,
        numSigDig: null,
        declLine: 11,
        boundary: null,
        priorValue: null,
        priorVariance: null,
        priorDf: null,
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
      cnvVerdict: null,
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

  it('init falls back to .ext iteration-0 when vscode-nmtran returned NaN / undefined; impliedInit flag set', () => {
    // vscode-nmtran has been observed returning init: NaN for some
    // bare-form declarations. The .ext iteration-0 row has the value
    // NONMEM actually used; pickInit falls back to it AND sets
    // `impliedInit: true` so the client renders muted-with-tooltip.
    const payload = buildInspectorPayload(
      model({
        thetas: [{ index: 1, init: NaN, fix: false }],
        omegas: [{ index: 1, value: NaN, fix: false }],
      }),
      {
        lstPath: '/work/m.lst',
        fit: fit({ 'THETA(1)': 1, 'OMEGA(1,1)': 0.1 }, {}, { 'THETA(1)': 1, 'OMEGA(1,1)': 0.1 }),
      },
    );
    expect(payload!.thetas[0].init).toBe(1);
    expect(payload!.thetas[0].impliedInit).toBe(true);
    expect(payload!.omegas[0].init).toBe(0.1);
    expect(payload!.omegas[0].impliedInit).toBe(true);
  });

  it('finite model init keeps impliedInit=false (no muted-tooltip render)', () => {
    const payload = buildInspectorPayload(
      model({ thetas: [{ index: 1, init: 4.79, fix: false }] }),
      {
        lstPath: '/work/m.lst',
        fit: fit({ 'THETA(1)': 5.0 }, {}, { 'THETA(1)': 4.79 }),
      },
    );
    expect(payload!.thetas[0].init).toBe(4.79);
    expect(payload!.thetas[0].impliedInit).toBe(false);
  });

  it('phantom decl rows not in .ext are filtered out (lst-mode trusts .ext as authoritative)', () => {
    // vscode-nmtran has been observed returning extra phantom THETA /
    // OMEGA / SIGMA entries for some forms (e.g. `$THETA 1` with simple
    // models). The .ext is authoritative for the parameter count; rows
    // whose access key isn't a column in `fit.finals` get dropped so the
    // inspector matches what NONMEM actually ran.
    const payload = buildInspectorPayload(
      model({
        thetas: [
          { index: 1, init: 1, fix: false },
          { index: 2, init: 5, fix: false }, // phantom — not in fit.ext
          { index: 3, init: 7, fix: false }, // phantom — not in fit.ext
        ],
      }),
      { lstPath: '/work/run001.lst', fit: fit({ 'THETA(1)': 2.0 }, { 'THETA(1)': 0.1 }) },
    );
    expect(payload!.thetas).toHaveLength(1);
    expect(payload!.thetas[0]).toMatchObject({ init: 1, final: 2.0, se: 0.1 });
  });

  it('mod-mode passes all decls through (no .ext to filter against)', () => {
    // No `fit` arg means no .ext — the filter is bypassed and all
    // declared parameters render even if they wouldn't appear in a run.
    const payload = buildInspectorPayload(
      model({
        thetas: [
          { index: 1, init: 1, fix: false },
          { index: 2, init: 5, fix: false },
        ],
      }),
    );
    expect(payload!.thetas).toHaveLength(2);
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

    it("THETA with no explicit bounds: boundary uses NONMEM's implicit ±1e+06 sentinels", () => {
      // No explicit bounds in the .mod, but NONMEM uses ±1e6 as the
      // no-bound sentinel internally. The inspector now compares
      // against those sentinels too, matching the muted-bound display.
      // A final at the interior is null:
      const interior = buildInspectorPayload(
        model({ thetas: [{ index: 1, init: 5, fix: false }] }),
        { lstPath: '/work/run001.lst', fit: fit({ 'THETA(1)': 5 }) },
      );
      expect(interior!.thetas[0].boundary).toBeNull();
      // A final pegged at the implicit upper sentinel IS flagged:
      const upperPeg = buildInspectorPayload(
        model({ thetas: [{ index: 1, init: 5, fix: false }] }),
        { lstPath: '/work/run001.lst', fit: fit({ 'THETA(1)': 1e6 }) },
      );
      expect(upperPeg!.thetas[0].boundary).toBe('upper');
      // And the implicit lower sentinel:
      const lowerPeg = buildInspectorPayload(
        model({ thetas: [{ index: 1, init: 5, fix: false }] }),
        { lstPath: '/work/run001.lst', fit: fit({ 'THETA(1)': -1e6 }) },
      );
      expect(lowerPeg!.thetas[0].boundary).toBe('lower');
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

  describe('NONMEM authoritative .ext sentinel rows', () => {
    it('surfaces stdcorr finals + SEs from -1000000004/-1000000005 on each row', () => {
      const payload = buildInspectorPayload(
        model({ omegas: [{ index: 1, value: 0.1, fix: false }] }),
        {
          lstPath: '/work/run001.lst',
          fit: fit(
            { 'OMEGA(1,1)': 0.1843 },
            { 'OMEGA(1,1)': 0.025 },
            {},
            {
              finalsStdcorr: { 'OMEGA(1,1)': 0.4293 },
              standardErrorsStdcorr: { 'OMEGA(1,1)': 0.0291 },
            },
          ),
        },
      );
      const row = payload!.omegas[0];
      expect(row.finalStdcorr).toBeCloseTo(0.4293, 3);
      expect(row.seStdcorr).toBeCloseTo(0.0291, 3);
      // RSE on SD scale: 0.0291 / 0.4293 ≈ 0.0678. No /2 factor — NONMEM's
      // delta-method propagation is already baked into seStdcorr.
      expect(row.rseStdcorr).toBeCloseTo(0.0678, 3);
      // Variance-form rse stays available too, computed via cvse/2.
      expect(row.rse).toBeCloseTo(0.025 / 0.1843 / 2, 4);
    });

    it('prefers .ext fixedFlags over the .mod-parsed fix bit when both present', () => {
      // .mod parses THETA(1) as not fixed, but .ext -1000000006 says it IS.
      // Authoritative source: NONMEM, not the editor's stale parse.
      const payload = buildInspectorPayload(
        model({
          thetas: [{ index: 1, init: 4.79, fix: false }],
          omegas: [{ index: 1, value: 0.1, fix: false }],
        }),
        {
          lstPath: '/work/run001.lst',
          fit: fit(
            { 'THETA(1)': 4.79, 'OMEGA(1,1)': 0.1 },
            {},
            {},
            { fixedFlags: { 'THETA(1)': true, 'OMEGA(1,1)': false } },
          ),
        },
      );
      expect(payload!.thetas[0].fixed).toBe(true);
      expect(payload!.omegas[0].fixed).toBe(false);
    });

    it('threads termination codes from -1000000007 into diagnostics; falls back to .lst.objv when fit absent', () => {
      const payload = buildInspectorPayload(
        model({ thetas: [{ index: 1, init: 1, fix: false }] }),
        {
          lstPath: '/work/run001.lst',
          // Mimic the "no .ext yet, .lst already parsed" window between
          // sumo running and the .ext being read — OFV should fall back
          // to lst.objv rather than going null.
          lst: mockLst({
            method: 'FOCE',
            methodShort: 'FOCE',
            objv: -123.456,
            termination: 'SUCCESSFUL',
            terminationPhrase: 'MINIMIZATION SUCCESSFUL',
          }),
          fit: fit({ 'THETA(1)': 1 }, {}, {}, { terminationCodes: [0, 1] }),
        },
      );
      expect(payload!.diagnostics!.terminationCodes).toEqual([0, 1]);
      // OFV from .ext takes priority over .lst.objv (both present here).
      expect(payload!.summary!.ofv).toBe(-638.795);
    });

    it('summary.ofv falls back to lst.objv when fit is absent (no .ext yet)', () => {
      const payload = buildInspectorPayload(
        model({ thetas: [{ index: 1, init: 1, fix: false }] }),
        {
          lstPath: '/work/run001.lst',
          lst: mockLst({ method: 'FOCE', methodShort: 'FOCE', objv: -42.0 }),
        },
      );
      expect(payload!.summary!.ofv).toBe(-42.0);
    });
  });
});
