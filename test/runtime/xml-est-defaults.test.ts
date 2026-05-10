import { describe, it, expect } from 'vitest';
import {
  findDefaultsForStep,
  findNonDefaultKeys,
  findPropagatedKeys,
  findUserDrivenKeys,
} from '../../src/runtime/xml-est-defaults';

describe('findDefaultsForStep', () => {
  it('routes any classical (no estimation_method) to the single FOCE baseline', () => {
    // FOCE-INTER / FOCE / FO / LAPLACE all map to FOCE; their distinct
    // attr values (epseta_interaction, cond_estim, laplace) get
    // flagged via the diff, not via separate baselines.
    const focePlain = findDefaultsForStep({});
    const foceInter = findDefaultsForStep({ epseta_interaction: 'yes' });
    expect(focePlain).not.toBeNull();
    expect(foceInter).not.toBeNull();
    expect(focePlain).toBe(foceInter);                          // same baseline reference
    expect(focePlain!.epseta_interaction).toBe('no');           // FOCE default = no INTER
  });

  it('routes IMP and IMP-EONLY to the same IMP baseline (eonly=1 is then a non-default diff)', () => {
    const imp = findDefaultsForStep({ estimation_method: 'imp', eonly: '0' });
    const eonly = findDefaultsForStep({ estimation_method: 'imp', eonly: '1' });
    expect(imp).toBe(eonly);                                     // single baseline
    expect(imp!.eonly).toBe('0');                                // canonical default
  });

  it('returns null for unknown methods (BAYES / NUTS / CHAIN not yet probed)', () => {
    expect(findDefaultsForStep({ estimation_method: 'bayes' })).toBeNull();
    expect(findDefaultsForStep({ estimation_method: 'nuts' })).toBeNull();
    expect(findDefaultsForStep({ estimation_method: 'chain' })).toBeNull();
  });

  it('routes IMPMAP to its own baseline (estimation_method differs from IMP)', () => {
    const d = findDefaultsForStep({ estimation_method: 'impmap' });
    expect(d).not.toBeNull();
    expect(d!.estimation_method).toBe('impmap');
  });

  it('routes DIRECT to its own baseline (lighter than IMP, no iaccept/iscale)', () => {
    const d = findDefaultsForStep({ estimation_method: 'direct' });
    expect(d).not.toBeNull();
    expect(d!.estimation_method).toBe('direct');
    expect(d!.iaccept).toBeUndefined();
  });

  it('classical: ZERO/FO when no cond_estim attr; FOCE when cond_estim=yes; HYBRID when etas_fixed_to_zero present', () => {
    const fo = findDefaultsForStep({ epseta_interaction: 'no' });
    const foce = findDefaultsForStep({ cond_estim: 'yes', epseta_interaction: 'no' });
    const hybrid = findDefaultsForStep({ cond_estim: 'yes', etas_fixed_to_zero: '1' });
    expect(fo!.cond_estim).toBeUndefined();          // FO doesn't have cond_estim
    expect(foce!.cond_estim).toBe('yes');
    expect(hybrid!.cond_estim).toBe('yes');
    // FOCE and HYBRID both cond_estim=yes; HYBRID is its own baseline.
    expect(foce).not.toBe(hybrid);
  });
});

describe('findNonDefaultKeys', () => {
  it('returns empty array when every key matches the SAEM default', () => {
    const baseline: Record<string, string> = {
      estimation_method: 'saem',
      analysis_type: 'pop',
      eonly: '0',
      iaccept: '0.400000000000000',
      ikappa: '1.00000000000000',
      // niter / nburn / isample / seed are USER_DRIVEN_KEYS -> always skipped
      niter: '99999',
      nburn: '99999',
      isample: '99',
      seed: '42',
    };
    expect(findNonDefaultKeys(baseline)).toEqual([]);
  });

  it('flags keys that differ from the SAEM default; ignores user-driven keys; sorted', () => {
    const customised: Record<string, string> = {
      estimation_method: 'saem',
      analysis_type: 'pop',
      eonly: '0',
      ctype: '3',                 // SAEM default is '0' -> flagged
      iaccept: '0.5',              // SAEM default 0.4 -> flagged
      isample_m1: '5',             // SAEM default '2' -> flagged
      niter: '5000',               // user-driven (skipped)
      seed: '12345',               // user-driven (skipped)
    };
    expect(findNonDefaultKeys(customised)).toEqual(['ctype', 'iaccept', 'isample_m1']);
  });

  it('CTYPE-conditional defaults (calpha / citer) are present in EM baselines', () => {
    // SAEM/ITS/IMP/IMPMAP/DIRECT all carry these because user runs
    // with CTYPE>0 emit them; without the baseline entry, the
    // matches-default values would false-flag as non-default.
    const saem = findDefaultsForStep({ estimation_method: 'saem' });
    expect(saem!.calpha).toBe('5.000000000000000E-02');
    expect(saem!.citer).toBe('10');
    const imp = findDefaultsForStep({ estimation_method: 'imp' });
    expect(imp!.calpha).toBe('5.000000000000000E-02');
    const its = findDefaultsForStep({ estimation_method: 'its' });
    expect(its!.calpha).toBe('5.000000000000000E-02');
  });

  it('cinterval is in USER_DRIVEN_KEYS (defaults to PRINT, can\'t track via static baseline)', () => {
    // User dialing PRINT cascades to cinterval; we surface as green
    // rather than flag-blue based on a stale baseline.
    const customised: Record<string, string> = {
      estimation_method: 'saem',
      cinterval: '10',  // would be wrong-flagged if treated as non-default
    };
    expect(findUserDrivenKeys(customised)).toContain('cinterval');
    expect(findNonDefaultKeys(customised)).not.toContain('cinterval');
  });

  it('flags eonly=1 as non-default for IMP (single-baseline routing)', () => {
    // The mental model: user wrote EONLY=1, deliberate deviation from
    // METHOD=IMP's default (eonly=0) -> flag. (Earlier behaviour
    // routed to a separate IMP-EONLY baseline that hid this.)
    const eonly: Record<string, string> = {
      estimation_method: 'imp',
      eonly: '1',
    };
    expect(findNonDefaultKeys(eonly)).toContain('eonly');
  });

  it('flags epseta_interaction=yes as non-default for classical FOCE', () => {
    const inter: Record<string, string> = {
      epseta_interaction: 'yes',
      cond_estim: 'yes',
    };
    expect(findNonDefaultKeys(inter)).toContain('epseta_interaction');
  });

  it('returns empty array for unknown methods (no diff possible)', () => {
    const bayes = { estimation_method: 'bayes', niter: '1000' };
    expect(findNonDefaultKeys(bayes)).toEqual([]);
  });
});

describe('findNonDefaultKeys edge cases', () => {
  it('empty step routes to ZERO/FO baseline; no diff with no attrs', () => {
    expect(findNonDefaultKeys({})).toEqual([]);
  });

  it('IMPMAP with default mapinter does NOT false-flag (per binary-symbol-table reasoning)', () => {
    // The doc claims IMPMAP ≡ IMP+INTERACTION+MAPITER=1+MAPINTER=1 at
    // the algorithm level, but NM emits mapinter='0' for default
    // METHOD=IMPMAP. The IMPMAP baseline must reflect what's emitted,
    // not what's algorithmically equivalent — otherwise default IMPMAP
    // runs would mis-flag mapinter as customised.
    const impmapDefault: Record<string, string> = {
      estimation_method: 'impmap',
      mapinter: '0',
      mapiter: '1',
      mapcov: '1',
    };
    expect(findNonDefaultKeys(impmapDefault)).not.toContain('mapinter');
  });

  it('NM 7.7+ unknown attr (not in baseline) flags as non-default', () => {
    // Documented behaviour: when NM ships a new attr we haven't
    // baselined, treat as non-default. Better to flag visibly than
    // silently skip — surfaces the gap to a maintainer.
    const futureAttr: Record<string, string> = {
      estimation_method: 'saem',
      hypothetical_nm77_knob: 'something',
    };
    expect(findNonDefaultKeys(futureAttr)).toContain('hypothetical_nm77_knob');
  });
});

describe('findUserDrivenKeys', () => {
  it('returns the intersection of step keys and USER_DRIVEN_KEYS, sorted', () => {
    const step: Record<string, string> = {
      estimation_method: 'saem',
      eonly: '0',
      niter: '5000',
      nburn: '1000',
      isample: '2',
      seed: '12345',
      clockseed: '0',
      ctype: '3',
      analysis_type: 'pop',
    };
    expect(findUserDrivenKeys(step)).toEqual([
      'clockseed', 'estimation_method', 'isample', 'nburn', 'niter', 'seed',
    ]);
  });

  it('returns [] when the step has none of the user-driven keys', () => {
    expect(findUserDrivenKeys({ ctype: '3', analysis_type: 'pop' })).toEqual([]);
    expect(findUserDrivenKeys({})).toEqual([]);
  });
});

describe('findPropagatedKeys', () => {
  it('returns empty array for step 0 / no prev step', () => {
    const step = { estimation_method: 'imp', ctype: '3', isample: '300' };
    expect(findPropagatedKeys(step, null, [])).toEqual([]);
  });

  it('flags non-default attrs that match prev step AND user did NOT type on this step', () => {
    // SAEM step 1 with explicit CTYPE=3, NOPRIOR=1.
    // IMP step 2 inherits both (user wrote nothing on step 2's $EST line).
    const prev = { estimation_method: 'saem', ctype: '3', noprior: '1' };
    const curr = { estimation_method: 'imp', ctype: '3', noprior: '1', isample: '300' };
    const tokens = ['METHOD=IMP', 'EONLY=1', 'NITER=5'];
    const propagated = findPropagatedKeys(curr, prev, tokens);
    // ctype and noprior matched prev AND not in tokens → propagated.
    expect(propagated).toContain('ctype');
    expect(propagated).toContain('noprior');
    // isample is in IMP defaults at 300, so not flagged non-default → not propagated.
  });

  it('does NOT flag attrs the user explicitly typed on the current step', () => {
    // User wrote CTYPE=3 explicitly on step 2; same value as step 1 → still NOT propagated.
    const prev = { estimation_method: 'saem', ctype: '3' };
    const curr = { estimation_method: 'imp', ctype: '3', isample: '300' };
    const tokens = ['METHOD=IMP', 'CTYPE=3', 'ISAMPLE=300'];
    expect(findPropagatedKeys(curr, prev, tokens)).not.toContain('ctype');
  });

  it('alias: METHOD=COND on tokens prevents cond_estim from being flagged propagated', () => {
    // FOCE step 1 → another FOCE step 2 with explicit METHOD=COND.
    const prev = { cond_estim: 'yes', epseta_interaction: 'yes' };
    const curr = { cond_estim: 'yes', epseta_interaction: 'yes' };
    const tokens = ['METHOD=COND', 'INTER'];
    const propagated = findPropagatedKeys(curr, prev, tokens);
    // METHOD=COND token covers cond_estim (and fo_model_app);
    // INTER token covers epseta_interaction.
    expect(propagated).not.toContain('cond_estim');
    expect(propagated).not.toContain('epseta_interaction');
  });

  it('alias: NOABORT token prevents abort=no from being flagged propagated', () => {
    const prev = { abort: 'no' };
    const curr = { abort: 'no' };
    expect(findPropagatedKeys(curr, prev, ['METHOD=COND', 'NOABORT'])).not.toContain('abort');
    expect(findPropagatedKeys(curr, prev, ['METHOD=COND', 'NOHABORT'])).not.toContain('abort');
    // No NOABORT/NOHABORT token → propagated
    expect(findPropagatedKeys(curr, prev, ['METHOD=COND'])).toContain('abort');
  });

  it('does NOT flag user-driven keys (niter, isample, seed, etc.) — they have their own tier', () => {
    const prev = { estimation_method: 'saem', niter: '100', seed: '42' };
    const curr = { estimation_method: 'imp', niter: '100', seed: '42', isample: '300' };
    // User-driven keys are excluded from findNonDefaultKeys, so propagated also skips them.
    const propagated = findPropagatedKeys(curr, prev, ['METHOD=IMP']);
    expect(propagated).not.toContain('niter');
    expect(propagated).not.toContain('seed');
  });

  it('does NOT flag attrs that differ from prev step', () => {
    const prev = { estimation_method: 'saem', ctype: '3' };
    const curr = { estimation_method: 'imp', ctype: '0' }; // ctype differs
    expect(findPropagatedKeys(curr, prev, ['METHOD=IMP'])).not.toContain('ctype');
  });

  it('returns sorted output', () => {
    const prev = { estimation_method: 'saem', ctype: '3', noprior: '1', mceta: '5' };
    const curr = { estimation_method: 'imp', ctype: '3', noprior: '1', mceta: '5', isample: '300' };
    const propagated = findPropagatedKeys(curr, prev, ['METHOD=IMP']);
    expect(propagated).toEqual([...propagated].sort());
  });
});
