import { describe, it, expect } from 'vitest';

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
describe('resolveCovAttrToRuntime', () => {
  const noTrace = {
    baseNrd: null,
    baseAnrd: null,
    estNrd: null,
    estAnrd: null,
    covNrd: null,
    covAnrd: null,
    siglo: null,
    sigl: null,
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
    expect(resolveCovAttrToRuntime('file', 'BLANK', lastEst, noTrace, 'classical')).toBe(
      'run001.ext',
    );
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
    expect(
      resolveCovAttrToRuntime('hypothetical_attr', '-1', null, noTrace, 'classical'),
    ).toBeNull();
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
    expect(classifyCovStep({ ...BARE, slow_gradient: 'slow' }, ['SLOW']).slow_gradient).toBe(
      'explicit',
    );
    expect(classifyCovStep({ ...BARE, slow_gradient: 'fast' }, ['FAST']).slow_gradient).toBe(
      'explicit',
    );
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
