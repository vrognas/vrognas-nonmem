// Tests for the extracted $EST / $COV cell-builders in client.js
// (v0.0.201 refactor). The file is a plain WebView script that runs
// side-effecting top-level code (acquireVsCodeApi, window/document
// listeners). Stub those globals before importing so vitest can pull
// in the pure helpers without exploding on missing browser APIs.
import { describe, it, expect, vi } from 'vitest';

vi.stubGlobal('acquireVsCodeApi', () => ({
  postMessage: vi.fn(),
  getState: () => null,
  setState: vi.fn(),
}));
vi.stubGlobal('document', {
  getElementById: () => null,
  createElement: () => ({ append: vi.fn(), setAttribute: vi.fn() }),
});
vi.stubGlobal('window', { addEventListener: vi.fn() });

// @ts-expect-error — plain JS file with module.exports guard
const clientModule = await import('../../media/fit-inspector/client.js');
const { classifyAttrTier, buildEstAttrCell, buildCovAttrCell } = clientModule;

describe('classifyAttrTier', () => {
  it('synthesised user-set + matches doc default → explicit-default tier', () => {
    const r = classifyAttrTier(
      'posthoc',
      { isUserSet: true, value: 'yes', inapplicable: false },
      {},
      { posthoc: 'yes' },
      'est',
    );
    expect(r.cls).toContain('xml-options-val--explicit-default');
    expect(r.tip).toContain('matches default');
  });

  it('synthesised user-set + differs from doc default → explicit tier', () => {
    const r = classifyAttrTier(
      'posthoc',
      { isUserSet: true, value: 'no', inapplicable: false },
      {},
      { posthoc: 'yes' },
      'est',
    );
    expect(r.cls).toContain('xml-options-val--explicit');
    expect(r.cls).not.toContain('explicit-default');
  });

  it('synthesised not-user-set → no tier class, synthDoc tip', () => {
    const r = classifyAttrTier(
      'posthoc',
      { isUserSet: false, value: 'yes', inapplicable: false },
      {},
      { posthoc: 'yes' },
      'est',
    );
    expect(r.cls).toBe('xml-options-val');
    expect(r.tip).toMatch(/Documented default/);
  });

  it('XML-emitted with explicit tier → explicit class + est-scope tip', () => {
    const r = classifyAttrTier('method', undefined, { method: 'explicit' }, {}, 'est');
    expect(r.cls).toContain('xml-options-val--explicit');
    expect(r.tip).toContain('$EST');
  });

  it('XML-emitted with implicit tier → implicit class', () => {
    const r = classifyAttrTier('niter', undefined, { niter: 'implicit' }, {}, 'est');
    expect(r.cls).toContain('xml-options-val--implicit');
  });

  it('cov scope uses $COV wording in tip', () => {
    const r = classifyAttrTier('matrix', undefined, { matrix: 'explicit' }, {}, 'cov');
    expect(r.tip).toContain('$COV');
    expect(r.tip).not.toContain('$EST');
  });

  it('no tier hit + no synth match → no class, no tip', () => {
    const r = classifyAttrTier('unknown', undefined, {}, {}, 'est');
    expect(r.cls).toBe('xml-options-val');
    expect(r.tip).toBeUndefined();
  });
});

describe('buildEstAttrCell — NOABORT/NOHABORT disambiguation', () => {
  const baseCtx = {
    merged: { abort: 'no' },
    synthetic: {},
    tierMap: { abort: 'explicit' },
    methodKind: 'foce',
    userWroteNoabort: false,
    userWroteNohabort: false,
    tolerances: null,
  };

  it('abort=no + user wrote NOHABORT → NOHABORT-flavoured tip', () => {
    const r = buildEstAttrCell({ ...baseCtx, k: 'abort', userWroteNohabort: true });
    expect(r.tip).toMatch(/^NOHABORT:/);
    expect(r.tip).toContain('same as NOABORT');
  });

  it('abort=no + user wrote NOABORT → NOABORT-flavoured tip', () => {
    const r = buildEstAttrCell({ ...baseCtx, k: 'abort', userWroteNoabort: true });
    expect(r.tip).toMatch(/^NOABORT:/);
    expect(r.tip).toContain('same as NOHABORT');
  });

  it('abort=no without either user-token → ambiguity note appended', () => {
    const r = buildEstAttrCell({ ...baseCtx, k: 'abort' });
    expect(r.tip).toContain('shared by NOABORT and NOHABORT');
  });
});

describe('buildEstAttrCell — PsN-wrapper annotation', () => {
  it('file=psn.ext + tier=implicit → PsN wrapper note appended', () => {
    const r = buildEstAttrCell({
      k: 'file',
      merged: { file: 'psn.ext' },
      synthetic: {},
      tierMap: { file: 'implicit' },
      methodKind: 'foce',
      userWroteNoabort: false,
      userWroteNohabort: false,
      tolerances: null,
    });
    expect(r.tip).toContain("PsN's execute wrapper");
  });

  it('file=psn.ext + tier=explicit → no PsN note (user intentionally typed it)', () => {
    const r = buildEstAttrCell({
      k: 'file',
      merged: { file: 'psn.ext' },
      synthetic: {},
      tierMap: { file: 'explicit' },
      methodKind: 'foce',
      userWroteNoabort: false,
      userWroteNohabort: false,
      tolerances: null,
    });
    expect(r.tip).not.toContain("PsN's execute wrapper");
  });
});

describe('buildCovAttrCell — MATRIX=R + SPECIAL quirk', () => {
  it('user-typed SPECIAL while MATRIX=R is active → warning appended (tip-undefined-safe)', () => {
    // Note: `tiersMap` empty + no synthEntry would return tip=undefined
    // from classifyAttrTier; the v0.0.204 fix guards with (tip || '') +.
    // Use a real synth entry to exercise both the synth + warning paths.
    const r = buildCovAttrCell({
      k: 'special',
      merged: { special: 'yes' },
      synthetic: {
        special: { isUserSet: true, value: 'yes', inapplicable: false },
      },
      tiersMap: {},
      resolvedMap: {},
      lstTolerances: null,
      matrixIsR: true,
    });
    expect(r.tip).toContain('NM silently ignores SPECIAL when MATRIX=R');
  });

  it('no MATRIX=R → no warning even when user typed SPECIAL', () => {
    const r = buildCovAttrCell({
      k: 'special',
      merged: { special: 'yes' },
      synthetic: {
        special: { isUserSet: true, value: 'yes', inapplicable: false },
      },
      tiersMap: {},
      resolvedMap: {},
      lstTolerances: null,
      matrixIsR: false,
    });
    expect(r.tip).not.toContain('NM silently ignores SPECIAL');
  });

  it('returns the merged value as displayValue when no wire→runtime resolution applies', () => {
    const r = buildCovAttrCell({
      k: 'matrix',
      merged: { matrix: 'r' },
      synthetic: {},
      tiersMap: { matrix: 'explicit' },
      resolvedMap: {},
      lstTolerances: null,
      matrixIsR: true,
    });
    expect(r.displayValue).toBe('r');
  });
});
