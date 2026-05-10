import { describe, it, expect } from 'vitest';
import { classifyCovKeys } from '../../src/runtime/xml-cov-defaults';

// Empirically-probed bare-$COV baseline (NM 7.6.0, see
// `~/positron-nonmem/probe-cov*` on host).
const BARE_BASELINE = {
  atol: '-1',
  cholroff: '0',
  compressed: 'no',
  eigen_print: 'no',
  fposdef: '0',
  knuthsumoff: '-1',
  matrix: 'rsr',
  nofcov: 'no',
  omitted: 'no',
  pfcond: '0',
  posdef: '-1',
  precond: '0',
  preconds: 'tos',
  pretype: '0',
  resume: 'no',
  siglcov: '-1',
  siglocov: '-1',
  sirsample: 'BLANK',
  slow_gradient: 'noslow',
  special: 'no',
  thbnd: '1',
  tol: '-1',
};

describe('classifyCovKeys', () => {
  it('all bare-baseline values produce empty result (everything matches default)', () => {
    expect(classifyCovKeys(BARE_BASELINE, null)).toEqual({});
  });

  it('flags MATRIX=R and THBND=0 as non-default (blue)', () => {
    const cov = { ...BARE_BASELINE, matrix: 'r', thbnd: '0' };
    expect(classifyCovKeys(cov, null)).toEqual({
      matrix: 'nonDefault',
      thbnd: 'nonDefault',
    });
  });

  it('does NOT flag cov_atol=-1 as propagated when $EST is also at default', () => {
    // Bug from prod: user reported cov_atol='-1' rendered yellow when
    // $EST atol was also at the default '0'. Effective value is the
    // built-in default; nothing to "look elsewhere" for. FOCE classical:
    // estimation_method is absent in the XML, presence of cond_estim
    // is the FOCE discriminator.
    const est = { atol: '0', cond_estim: 'yes' };
    expect(classifyCovKeys(BARE_BASELINE, est)).toEqual({});
  });

  it('flags cov_atol=-1 as propagated when $EST atol is user-customised', () => {
    // User wrote $EST METHOD=COND ATOL=10. $COV inherits → yellow.
    // Classical FOCE: estimation_method absent, cond_estim='yes'.
    const est = { atol: '10', cond_estim: 'yes' };
    expect(classifyCovKeys(BARE_BASELINE, est).atol).toBe('propagated');
  });

  it('flags cov_siglcov=-1 as propagated when $EST sigl is user-customised', () => {
    // Sibling mapping: cov_siglcov ↔ est_sigl. Classical FOCE.
    const est = { sigl: '10', cond_estim: 'yes' };
    expect(classifyCovKeys(BARE_BASELINE, est).siglcov).toBe('propagated');
  });

  it('does NOT flag cov_tol=-1 as propagated (chain skips $EST through $SUBROUTINES)', () => {
    // $COV TOL inherits from $SUBROUTINES directly — no $EST sibling
    // we can cross-reference. Render normal even when $EST has unrelated
    // user-customised attrs.
    const est = { atol: '10', cond_estim: 'yes' };
    const result = classifyCovKeys(BARE_BASELINE, est);
    expect(result.tol).toBeUndefined();
  });

  it('does NOT flag cov_posdef=-1 as propagated (method-determined default)', () => {
    // posdef='-1' means "use 0 for classical / 3 for EM" — not propagation
    // from $EST. Render normal.
    const est = { atol: '10', cond_estim: 'yes' };
    expect(classifyCovKeys(BARE_BASELINE, est).posdef).toBeUndefined();
  });

  it('does NOT flag sirsample=BLANK as user-driven (BLANK is the not-set default)', () => {
    // Bug from prod: sirsample='BLANK' rendered green because it was
    // unconditionally classified as user-driven. BLANK is NM's
    // not-requested sentinel — not a user setting. Render normal.
    expect(classifyCovKeys(BARE_BASELINE, null).sirsample).toBeUndefined();
  });

  it('flags sirsample=300 as user-driven (differs from BLANK)', () => {
    // SIR active. Note that with SIR active, SIR_BLOCK joins the
    // baseline so `seed='11456'` etc match defaults and don't flag.
    const cov = {
      ...BARE_BASELINE,
      sirsample: '300',
      sirniter: '1', // SIR_BLOCK default
      seed: '11456', // SIR_BLOCK default
    };
    const result = classifyCovKeys(cov, null);
    expect(result.sirsample).toBe('userDriven');
    expect(result.sirniter).toBeUndefined();
    expect(result.seed).toBeUndefined();
  });

  it('flags seed=12345 as user-driven (differs from default 11456 in SIR mode)', () => {
    const cov = {
      ...BARE_BASELINE,
      sirsample: '300',
      seed: '12345',
    };
    expect(classifyCovKeys(cov, null).seed).toBe('userDriven');
  });

  it('SIR detection: sirsample=0 does NOT activate SIR_BLOCK (Number-based check)', () => {
    // Defensive: review-time bug fix. Non-numeric `'BLANK'` → NaN → false;
    // `'0'` → 0 → false; only positive numerics activate SIR_BLOCK.
    // Regression: previously `'sirsample' in opts && opts.sirsample !== 'BLANK'`
    // would mis-fire on '0'.
    const cov = { ...BARE_BASELINE, sirsample: '0' };
    // SIR_BLOCK keys (e.g. iaccept) shouldn't be in the baseline.
    // Adding iaccept='1.5' to cov should flag non-default since the
    // SIR_BLOCK default doesn't apply.
    const withIaccept = { ...cov, iaccept: '1.5' };
    expect(classifyCovKeys(withIaccept, null).iaccept).toBe('nonDefault');
  });

  it('flags NM 7.7+ unknown attrs (not in baseline) as non-default', () => {
    const cov = { ...BARE_BASELINE, hypothetical_nm77_knob: 'something' };
    expect(classifyCovKeys(cov, null).hypothetical_nm77_knob).toBe('nonDefault');
  });

  it('returns empty result when no $COV options at all', () => {
    expect(classifyCovKeys({}, null)).toEqual({});
  });
});

describe('resolveCovAttrToRuntime', () => {
  const noTrace = {
    baseNrd: null, baseAnrd: null, estNrd: null, estAnrd: null,
    covNrd: null, covAnrd: null, siglo: null, sigl: null,
  };

  it('atol=-1: resolves via lstTolerances.covAnrd', async () => {
    const { resolveCovAttrToRuntime } = await import('../../src/runtime/xml-cov-defaults');
    const trace = { ...noTrace, covAnrd: '12' };
    expect(resolveCovAttrToRuntime('atol', '-1', null, trace, 'classical')).toBe('12');
  });

  it('tol=-1: resolves via lstTolerances.covNrd', async () => {
    const { resolveCovAttrToRuntime } = await import('../../src/runtime/xml-cov-defaults');
    const trace = { ...noTrace, covNrd: '6' };
    expect(resolveCovAttrToRuntime('tol', '-1', null, trace, 'classical')).toBe('6');
  });

  it('siglcov=-1: resolves via $EST sigl (or lst trace)', async () => {
    const { resolveCovAttrToRuntime } = await import('../../src/runtime/xml-cov-defaults');
    const lastEst = { sigl: '8', siglo: '5', estimation_method: '' };
    expect(resolveCovAttrToRuntime('siglcov', '-1', lastEst, noTrace, 'classical')).toBe('8');
    expect(resolveCovAttrToRuntime('siglocov', '-1', lastEst, noTrace, 'classical')).toBe('5');
  });

  it('posdef=-1: classical → 0, em → 3, null → 0 (classical-fallback)', async () => {
    const { resolveCovAttrToRuntime } = await import('../../src/runtime/xml-cov-defaults');
    expect(resolveCovAttrToRuntime('posdef', '-1', null, noTrace, 'classical')).toBe('0');
    expect(resolveCovAttrToRuntime('posdef', '-1', null, noTrace, 'em')).toBe('3');
    // v0.0.187: null method falls back to '0' (classical is the common
    // case; safer than leaking the wire sentinel).
    expect(resolveCovAttrToRuntime('posdef', '-1', null, noTrace, null)).toBe('0');
  });

  it('file=BLANK: resolves via $EST file (SIR-active case)', async () => {
    const { resolveCovAttrToRuntime } = await import('../../src/runtime/xml-cov-defaults');
    const lastEst = { file: 'run001.ext', estimation_method: '' };
    expect(resolveCovAttrToRuntime('file', 'BLANK', lastEst, noTrace, 'classical')).toBe('run001.ext');
  });

  it('ranmethod=BLANK: resolves to documented default "3"', async () => {
    const { resolveCovAttrToRuntime } = await import('../../src/runtime/xml-cov-defaults');
    expect(resolveCovAttrToRuntime('ranmethod', 'BLANK', null, noTrace, 'classical')).toBe('3');
  });

  it('non-sentinel values: returns null (no translation)', async () => {
    const { resolveCovAttrToRuntime } = await import('../../src/runtime/xml-cov-defaults');
    expect(resolveCovAttrToRuntime('atol', '5', null, noTrace, 'classical')).toBeNull();
    expect(resolveCovAttrToRuntime('matrix', 'rsr', null, noTrace, 'classical')).toBeNull();
  });

  it('unknown sentinel-bearing key returns null', async () => {
    const { resolveCovAttrToRuntime } = await import('../../src/runtime/xml-cov-defaults');
    expect(resolveCovAttrToRuntime('hypothetical_attr', '-1', null, noTrace, 'classical')).toBeNull();
  });
});

describe('classifyCovStep (v0.0.185+ unified tier scheme)', () => {
  const BARE = { ...BARE_BASELINE };

  it('all bare-baseline + no tokens → empty result (all unstyled)', async () => {
    const { classifyCovStep } = await import('../../src/runtime/xml-cov-defaults');
    expect(classifyCovStep(BARE, [])).toEqual({});
  });

  it('user-typed MATRIX=R → explicit (blue)', async () => {
    const { classifyCovStep } = await import('../../src/runtime/xml-cov-defaults');
    const cov = { ...BARE, matrix: 'r' };
    const tiers = classifyCovStep(cov, ['MATRIX=R']);
    expect(tiers.matrix).toBe('explicit');
  });

  it('user-typed THBND=1 (matches default 1) → explicitDefault (italic blue)', async () => {
    const { classifyCovStep } = await import('../../src/runtime/xml-cov-defaults');
    const cov = { ...BARE, thbnd: '1' };
    const tiers = classifyCovStep(cov, ['THBND=1']);
    expect(tiers.thbnd).toBe('explicitDefault');
  });

  it('user did NOT type but value differs from default → implicit (orange)', async () => {
    const { classifyCovStep } = await import('../../src/runtime/xml-cov-defaults');
    // SIR active (sirsample='300') but user didn't type CAPCORR; the
    // SIR_BLOCK has capcorr=1.0 by default. If wire shows different,
    // implicit.
    const cov = { ...BARE, sirsample: '300', capcorr: '0.5' };
    const tiers = classifyCovStep(cov, ['SIRSAMPLE=300']);
    expect(tiers.capcorr).toBe('implicit');
  });

  it('alias-aware: COMPRESS token → explicit on cov_compressed', async () => {
    const { classifyCovStep } = await import('../../src/runtime/xml-cov-defaults');
    const cov = { ...BARE, compressed: 'yes' };
    const tiers = classifyCovStep(cov, ['COMPRESS']);
    expect(tiers.compressed).toBe('explicit');
  });

  it('alias-aware: SLOW/NOSLOW/FAST tokens → explicit on cov_slow_gradient', async () => {
    const { classifyCovStep } = await import('../../src/runtime/xml-cov-defaults');
    expect(classifyCovStep({ ...BARE, slow_gradient: 'slow' }, ['SLOW']).slow_gradient).toBe('explicit');
    expect(classifyCovStep({ ...BARE, slow_gradient: 'fast' }, ['FAST']).slow_gradient).toBe('explicit');
  });

  it('alias-aware: PRINT=E token → explicit on cov_eigen_print', async () => {
    const { classifyCovStep } = await import('../../src/runtime/xml-cov-defaults');
    const cov = { ...BARE, eigen_print: 'yes' };
    const tiers = classifyCovStep(cov, ['PRINT=E']);
    expect(tiers.eigen_print).toBe('explicit');
  });

  it('sentinel cov_atol=-1 (matches default) + not typed → unstyled', async () => {
    const { classifyCovStep } = await import('../../src/runtime/xml-cov-defaults');
    const cov = { ...BARE, atol: '-1' };
    const tiers = classifyCovStep(cov, []);
    expect(tiers.atol).toBeUndefined();
  });

  it('user typed ATOL=10 → explicit (overrides sentinel)', async () => {
    const { classifyCovStep } = await import('../../src/runtime/xml-cov-defaults');
    const cov = { ...BARE, atol: '10' };
    const tiers = classifyCovStep(cov, ['ATOL=10']);
    expect(tiers.atol).toBe('explicit');
  });
});
