import { describe, it, expect } from 'vitest';
import { classifyCnv } from '../../src/views/cnv-verdict';
import type { CnvTable } from '../../src/runtime/parse-cnv';

const allConverged: CnvTable = {
  method: 'SAEM',
  paramNames: ['THETA1', 'THETA2', 'OMEGA(1,1)', 'SAEMOBJ'],
  means: [1, 1, 0.1, -100],
  sds: [0.001, 0.001, 0.001, 1],
  pValues: [0.92, 0.85, 0.71, 0.34],
  alphas: [0.0125, 0.0125, 0.0125, 0.05],
};

const ofvNotConverged: CnvTable = {
  method: 'SAEM',
  paramNames: ['THETA1', 'OMEGA(1,1)', 'SAEMOBJ'],
  means: [1, 0.1, -100],
  sds: [0.001, 0.001, 1],
  pValues: [0.92, 0.71, 0.001], // OFV p < α
  alphas: [0.025, 0.025, 0.05],
};

const oneParamNotConverged: CnvTable = {
  method: 'SAEM',
  paramNames: ['THETA1', 'OMEGA(1,1)', 'SAEMOBJ'],
  means: [1, 0.1, -100],
  sds: [0.001, 0.001, 1],
  pValues: [0.92, 0.001, 0.34], // OMEGA(1,1) drifting; OFV ok
  alphas: [0.025, 0.025, 0.05],
};

describe('classifyCnv', () => {
  it('reports converged when every param and the OFV meet p ≥ α', () => {
    const v = classifyCnv(allConverged)!;
    expect(v.converged).toBe(true);
    expect(v.ofvP).toBeCloseTo(0.34, 3);
    expect(v.ofvAlpha).toBeCloseTo(0.05, 3);
    expect(v.paramTotal).toBe(3);
    expect(v.paramConverged).toBe(3);
    expect(v.nonConvergedParams).toEqual([]);
  });

  it('flags not-converged when the OFV p falls below its α', () => {
    const v = classifyCnv(ofvNotConverged)!;
    expect(v.converged).toBe(false);
    // Params themselves were ok (THETA1, OMEGA(1,1) — both p >= 0.025).
    expect(v.paramTotal).toBe(2);
    expect(v.paramConverged).toBe(2);
    expect(v.nonConvergedParams).toEqual([]);
  });

  it('flags not-converged when any param p falls below its α; lists offenders', () => {
    const v = classifyCnv(oneParamNotConverged)!;
    expect(v.converged).toBe(false);
    expect(v.paramTotal).toBe(2);
    expect(v.paramConverged).toBe(1);
    expect(v.nonConvergedParams).toEqual(['OMEGA(1,1)']);
  });

  it('detects the OFV column by name (`/OBJ$/i`), not by position', () => {
    // OFV column NOT last — should still be picked correctly via name.
    // (Empirically NM7 always emits OFV last, but the verdict layer
    // shouldn't rely on that — confirm with a synthetic mid-position
    // SAEMOBJ. Both p ≥ α here, so verdict is converged.)
    const ofvMidPosition: CnvTable = {
      method: 'SAEM',
      paramNames: ['THETA1', 'SAEMOBJ', 'OMEGA(1,1)'],
      means: [1, -100, 0.1],
      sds: [0.001, 1, 0.001],
      pValues: [0.92, 0.34, 0.71],
      alphas: [0.025, 0.05, 0.025],
    };
    const v = classifyCnv(ofvMidPosition)!;
    expect(v.ofvP).toBeCloseTo(0.34, 3);
    expect(v.ofvAlpha).toBeCloseTo(0.05, 3);
    expect(v.paramTotal).toBe(2);
    expect(v.paramConverged).toBe(2);
    expect(v.converged).toBe(true);
  });

  it('returns null when input is null / malformed', () => {
    expect(classifyCnv(null)).toBeNull();
    expect(
      classifyCnv({
        method: 'X',
        paramNames: ['THETA1'],
        means: [1],
        sds: [0.1],
        pValues: [], // length mismatch
        alphas: [0.05],
      } as CnvTable),
    ).toBeNull();
  });
});
