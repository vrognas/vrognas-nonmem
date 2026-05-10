// NONMEM version pin: tables here were probed against **NONMEM 7.6.0**
// (2026-05-09). Re-probe when the host upgrades; defaults can shift
// silently between NM patches. Drift symptom: false-positive blue
// highlights on attrs whose true defaults moved.

// Empirical defaults for `<nm:estimation_options>` per estimation method.
// Captured 2026-05-09 against NONMEM 7.6.0 by running a minimal model
// (cubic + diagonal OMEGA) with `$EST METHOD=X` and the smallest
// option set NONMEM will accept (e.g. SAEM requires NBURN/NITER, IMP
// requires NITER/ISAMPLE -- those values land in the dictionary, but
// `USER_DRIVEN_KEYS` below excludes them from the diff so user-set
// values don't show as "non-default").
//
// **Coverage limits**, ordered by impact:
//
// 1. **Conditionally-emitted attrs** — e.g. `calpha` / `citer` only
//    emit when `CTYPE>0`. Resolved (v0.0.171): the SAEM/ITS/IMP/
//    IMPMAP/DIRECT baselines now include them at their NM-default
//    values, captured via probes with `CTYPE=3` set. User runs with
//    `CTYPE>0` and unmodified CALPHA/CITER won't false-positive blue.
//    NUTS family (NUTS_*) only for BAYES — still uncovered, since
//    BAYES itself isn't probed.
//
// 2. **Option-dependent defaults** — `cinterval` defaults to `PRINT`'s
//    value (which itself defaults to 9999). User who dials `PRINT=10`
//    causes `cinterval` to follow without typing it. A static
//    baseline can't track this cleanly, so `cinterval` lives in
//    `USER_DRIVEN_KEYS` (green tier) — surfaces the value without
//    misleadingly flagging it.
//
// 3. **Options that never emit to XML at all** — `PRINT`, `NOSUB`,
//    `OMITTED`, `NOABORT` / `ABORT` family, `NOCENTERING` /
//    `CENTERING`, etc. NM applies them but the XML wire-format
//    doesn't surface them. No way for our diff to highlight user
//    customization of these. Documented limitation, not fixable
//    without a different data source.
//
// Probes: `~/positron-nonmem/probe-defaults/{foce_inter,foce,its,imp,imp_eonly,saem}`.
//
// Match rules (`findDefaultsForStep`) — one baseline per method family;
// any user-set deviation from that baseline gets flagged:
//   estimation_method='its'           -> ITS
//   estimation_method='imp'           -> IMP    (eonly='1' flags as non-default)
//   estimation_method='impmap'        -> IMPMAP (Importance-Sampling-with-MAP)
//   estimation_method='saem'          -> SAEM
//   estimation_method='direct'        -> DIRECT (Monte Carlo Direct Sampling)
//   estimation_method absent + cond_estim='yes' + etas_fixed_to_zero present -> HYBRID
//   estimation_method absent + cond_estim='yes' -> FOCE
//   estimation_method absent (no cond_estim attr at all) -> ZERO (FO, the NM default)
//   otherwise                         -> null (no diff)
//
// Why no separate IMP-EONLY / FOCE-INTER tables: they'd only differ
// from IMP / FOCE on a single attr (`eonly` / `epseta_interaction`).
// Auto-routing to a sub-baseline would HIDE the user's explicit
// `EONLY=1` or `INTERACTION` choice (matches the sub-baseline -> not
// flagged). The user's mental model is "I wrote EONLY=1, that's a
// deliberate change from default" -> flag it. Single baseline per
// method gives that.
//
// BAYES not yet probed (needs `$PRIOR` plumbing for a minimal run);
// returns null until added.

import type { EstimationOptionsStep } from './parse-xml-options';

// ============================================================
// Composition layers — DRY-extracted from the 8 method baselines.
// Each method = COMMON + classical-extras + EM-extras + method-
// specific. Reduces ~150 lines of duplication and makes "what's
// genuinely different about this method" jump out at the reader.
// ============================================================

// Universal across all 8 methods (no method-specific values here).
const COMMON: Readonly<Record<string, string>> = {
  analysis_type: 'pop', atol: '0', ctype: '0', dercont: '0',
  estim_omitted: 'no', etader: '0', etastype: '0', evalshrink: '0',
  file: 'run001.ext', fnleta: '1', format: 's1pe12.5', knuthsumoff: '0',
  lntwopi: '0', maxfn: '528', mceta: '0', msfo: 'no', nocov: '0',
  nolabel: '0', noninfeta: '0', noprior: '0', notitle: '0', nsig: '3',
  numder: '0', objsort: 'no', olntwopi: '0', optmap: '0', order: 'tsol',
  predflag: '0', priorc: '0', saddle_hess: '0', saddle_reset: '0',
  sigl: '100', siglo: '100', slow_gradient: 'noslow',
};

// Classical-conditional layer: METHOD=COND family (FOCE / FOCE-INTER /
// LAPLACE / HYBRID). Adds `cond_estim`. FOCE adds centered_eta+laplace
// on top; HYBRID does NOT emit centered_eta or laplace (empirical).
const CONDITIONAL: Readonly<Record<string, string>> = {
  ...COMMON,
  cond_estim: 'yes',
};

// EM/MC base: shared by ITS/IMP/IMPMAP/SAEM/DIRECT. Builds on the
// FOCE-flavour classical attrs (cond_estim/centered_eta/laplace) and
// adds the EM-stochastic chain (anneal/auto/constrain/grd/mum) plus
// the CTYPE-conditional defaults that emit when CTYPE>0.
const EM_BASE: Readonly<Record<string, string>> = {
  ...CONDITIONAL,
  centered_eta: 'no',
  laplace: 'no',
  epseta_interaction: 'yes',
  anneal: 'BLANK',
  auto: '0',
  constrain: '1',
  grd: 'BLANK',
  mum: 'BLANK',
  // CTYPE-conditional defaults — emit only when CTYPE>0; including
  // their NM-default values here so user runs with CTYPE>0 and
  // unmodified CALPHA/CITER don't false-positive blue.
  calpha: '5.000000000000000E-02',
  citer: '10',
};

// Monte-Carlo stochastic chain: shared by IMP/IMPMAP/SAEM/DIRECT
// (NOT ITS — ITS is deterministic-EM, no MC sampling).
const MC_BASE: Readonly<Record<string, string>> = {
  clockseed: '0',
  eonly: '0',
  ranmethod: '3u',
  seed: '11456',
};

// IS-density tuning: shared by IMP and IMPMAP (importance-sampling
// proposal density knobs). Not in DIRECT (no proposal density;
// pure direct sampling) or SAEM (different kernel scheme).
const IS_DENSITY: Readonly<Record<string, string>> = {
  iaccept: '0.400000000000000',
  iacceptl: '0.00000000000000',
  iscale_min: '0.100000000000000',
  iscale_max: '10.0000000000000',
  df: '0',
  grdq: '0.00000000000000',
  mapcov: '1',
  mapinter: '0',
  mapiter: '1',
};

// ============================================================
// Per-method baselines, composed from the layers above.
// ============================================================

// ZERO / FO: actual NONMEM default if no METHOD specified. No
// conditional estimation — XML omits cond_estim/centered_eta/laplace.
// The matcher uses absence-of-`cond_estim` as the FO discriminator.
const ZERO: Readonly<Record<string, string>> = {
  ...COMMON,
  epseta_interaction: 'no',
};

// HYBRID: conditional estimation for some ETAs, FO for others. User
// MUST supply ZERO=(...) — `etas_fixed_to_zero` is in USER_DRIVEN_KEYS.
// Empirically: emits cond_estim but NOT centered_eta/laplace.
const HYBRID: Readonly<Record<string, string>> = {
  ...CONDITIONAL,
  epseta_interaction: 'no',
};

// FOCE baseline: METHOD=COND alone (no INTERACTION, no LAPLACE).
// User's INTERACTION flips epseta_interaction to 'yes' → flags blue.
const FOCE: Readonly<Record<string, string>> = {
  ...CONDITIONAL,
  centered_eta: 'no',
  laplace: 'no',
  epseta_interaction: 'no',
};

const ITS: Readonly<Record<string, string>> = {
  ...EM_BASE,
  estimation_method: 'its',
  niter: '5',
};

const IMP: Readonly<Record<string, string>> = {
  ...EM_BASE,
  ...MC_BASE,
  ...IS_DENSITY,
  estimation_method: 'imp',
  isample: '300',
  niter: '5',
};

// IMPMAP: identical to IMP except for the `estimation_method` value
// itself. Two distinct algorithms (IMP = pure importance sampling;
// IMPMAP runs MAP estimation as part of each importance-sampling
// step), but their tuning knobs and emitted defaults are the same
// set.
//
// Apparent paradox vs the NM7 doc: the
// [em-monte-carlo](https://nmguides.vrognas.com/nm7/em-monte-carlo)
// page claims IMPMAP is "equivalent to $EST METHOD=IMP INTERACTION
// MAPITER=1 MAPINTER=1" — yet NM emits `mapinter='0'` for default
// `METHOD=IMPMAP` (verified in both `<nm:estimation_options>` and the
// `.lst` ESTIMATION OPTIONS block).
//
// **Resolved by symbol-table inspection** of the shipped binary
// (`strings` + `nm` only — no disassembly, fair use). The
// `__nmbayes_int_MOD_*` namespace contains TWO parallel variables:
//   - `mapiter` / `mapinter` / `mapiters`        ← user-set values
//   - `emapiter` / `emapinter` / `emapinterstart` ← "effective"
//                                                  internal values
// plus a runtime string `"Mapinter turned on"`. So NM dispatches on
// `estimation_method='impmap'` and unconditionally sets `emapinter=1`
// regardless of the user-set `mapinter='0'`; the algorithmic effect
// matches the doc's claimed `IMP INTERACTION MAPITER=1 MAPINTER=1`
// equivalence, but only the user-set side reaches the XML / .lst.
//
// Don't "fix" this by setting `mapinter: '1'` in the table below —
// that would mis-flag a default `METHOD=IMPMAP` run as having a
// non-default `mapinter` value, when in fact the user wrote nothing.
// Surface-level mapping IS what the inspector should mirror.
const IMPMAP: Readonly<Record<string, string>> = {
  ...IMP,
  estimation_method: 'impmap',
};

// DIRECT (Monte Carlo Direct Sampling): EM-stochastic chain + MC_BASE
// but no IS-density tuning. Pure direct samples without proposal
// density.
const DIRECT: Readonly<Record<string, string>> = {
  ...EM_BASE,
  ...MC_BASE,
  estimation_method: 'direct',
  isample: '300',
  niter: '5',
};

// SAEM: stochastic-approximation EM. Has its own kernel-sampling
// regime (isample_m1/_m1a/_m1b/_m2/_m3, ikappa, massreset) and
// expanded iscale window vs IMP (1e-06 .. 1e6 vs 0.1 .. 10).
const SAEM: Readonly<Record<string, string>> = {
  ...EM_BASE,
  ...MC_BASE,
  estimation_method: 'saem',
  iaccept: '0.400000000000000',
  ikappa: '1.00000000000000',
  isample: '2',
  isample_m1: '2',
  isample_m1a: '0',
  isample_m1b: '2',
  isample_m2: '2',
  isample_m3: '2',
  iscale_max: '1000000.00000000',
  iscale_min: '1.000000000000000E-06',
  mapiters: '0',
  massreset: '-1',
  nburn: '10',
  niter: '10',
};

/**
 * Keys treated as "user-driven" rather than compared against defaults.
 * Three categories of why a key lands here:
 *
 *   - **NONMEM rejects without it** (no real default exists):
 *     `niter` (SAEM/IMP/ITS), `nburn` / `isample` (SAEM/IMP).
 *   - **Has a default, but per-run identity** — comparison is not
 *     user-meaningful:
 *     `seed` / `clockseed` (NM auto-derives 11456 / 0 if omitted, but
 *     users typically write their own).
 *   - **Identity / per-run filename**, not a configuration knob:
 *     `file`, `estimation_method`.
 *
 * Excluded from `findNonDefaultKeys` (won't render blue). Surfaced
 * separately by `findUserDrivenKeys` so the inspector can render
 * them green — distinguishing "I typed this" from "I customised this
 * away from method default" and "I accepted method default".
 */
export const USER_DRIVEN_KEYS: ReadonlySet<string> = new Set([
  'niter',
  'nburn',
  'isample',
  'seed',
  'clockseed',
  'file',
  'estimation_method',
  'etas_fixed_to_zero', // HYBRID-only: user supplies via ZERO=(...) list
  // `cinterval` defaults to whatever `PRINT` is set to (PRINT itself
  // defaults to 9999). User dialing PRINT cascades to cinterval
  // without explicit cinterval=. A static baseline can't model that
  // cleanly, so user-driven tier is the honest classification.
  'cinterval',
]);

/**
 * Find the defaults table for a given `<nm:estimation_options>` step.
 * Returns null when the method isn't covered (BAYES, MAP-only modes,
 * NM 7.7+ additions). Caller then skips the diff highlighting.
 */
export function findDefaultsForStep(step: EstimationOptionsStep): Readonly<Record<string, string>> | null {
  const m = (step.estimation_method ?? '').toLowerCase();
  if (m === 'its') return ITS;
  if (m === 'imp') return IMP;
  if (m === 'impmap') return IMPMAP;
  if (m === 'saem') return SAEM;
  if (m === 'direct') return DIRECT;
  // Classical: no estimation_method attr in the XML. Three variants:
  //   - HYBRID (cond_estim='yes' + etas_fixed_to_zero present)
  //   - FOCE   (cond_estim='yes', no etas_fixed_to_zero)
  //   - ZERO   (no cond_estim attr at all — FO; this is the NM default
  //             for `$EST` with no METHOD specified)
  if (m === '') {
    if (step.cond_estim === 'yes') {
      return step.etas_fixed_to_zero !== undefined ? HYBRID : FOCE;
    }
    return ZERO;
  }
  return null;
}

/**
 * Sorted list of attribute keys whose values differ from the method's
 * defaults. Empty array when the method has no defaults table
 * (returns `[]`, not null, so caller can naturally `.includes(k)` /
 * iterate without null-guarding). `USER_DRIVEN_KEYS` are always
 * excluded — those get their own green-tier classification via
 * `findUserDrivenKeys`. Sorted for deterministic test fixtures and
 * stable wire format.
 */
export function findNonDefaultKeys(step: EstimationOptionsStep): string[] {
  const defaults = findDefaultsForStep(step);
  if (!defaults) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(step)) {
    if (USER_DRIVEN_KEYS.has(key)) continue;
    const def = defaults[key];
    // If the default doesn't have this key (newer NM attr, or
    // contextual emit), treat as non-default — the user's run
    // emitted something the bare-method probe didn't.
    if (def === undefined || def !== value) out.push(key);
  }
  return out.sort();
}

/**
 * Sorted list of `USER_DRIVEN_KEYS` actually present in the step.
 * The intersection of "what the run carried" and "what we classify as
 * user-driven" — surfaces in the inspector as green-tinted values
 * (separate visual tier from non-default blue).
 */
export function findUserDrivenKeys(step: EstimationOptionsStep): string[] {
  const out: string[] = [];
  for (const key of Object.keys(step)) {
    if (USER_DRIVEN_KEYS.has(key)) out.push(key);
  }
  return out.sort();
}

/**
 * Map of XML attr name → patterns matching `$EST` tokens that, if
 * present in the user's verbatim line, indicate the user explicitly
 * set this attr. Most attrs use the trivial `KEY=` token form (handled
 * via fallback regex); this map covers attrs whose user-token form
 * differs (e.g. `INTERACTION` flag → `epseta_interaction='yes'`).
 *
 * Empirically validated against probes at
 * `~/positron-nonmem/probe-attrs-survey/` (NM 7.6.0).
 */
const ATTR_TO_USER_TOKENS: Readonly<Record<string, ReadonlyArray<RegExp>>> = {
  epseta_interaction: [/^INTER(ACTION)?$/i, /^NOINTER(ACTION)?$/i],
  laplace: [/^LAPLAC(IAN|E)$/i, /^NOLAPLAC(IAN|E)$/i],
  centered_eta: [/^CENTERING$/i, /^NOCENTERING$/i],
  abort: [/^NOABORT$/i, /^NOHABORT$/i, /^ABORT$/i],
  objsort: [/^N?O?SORT$/i],
  slow_gradient: [/^SLOW$/i, /^NOSLOW$/i, /^FAST$/i],
  // METHOD on $EST sets cond_estim, fo_model_app, and the
  // estimation_method attr value. Any METHOD= token counts as the user
  // having set those attrs explicitly.
  cond_estim: [/^METHOD=/i],
  fo_model_app: [/^METHOD=/i, /^N?O?FO$/i],
  estimation_method: [/^METHOD=/i],
  // SIGDIGITS is an NMTRAN alias for NSIG.
  nsig: [/^N?SIG(DIGITS)?=/i],
};

/**
 * True when the user's $EST tokens indicate an explicit setting of the
 * given XML attr. Combines the alias-aware `ATTR_TO_USER_TOKENS` map
 * with a generic `^attr=` fallback. Empty `tokens` → always false.
 */
function userWroteAttr(attr: string, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false;
  const aliases = ATTR_TO_USER_TOKENS[attr] ?? [];
  for (const re of aliases) {
    if (tokens.some((t) => re.test(t))) return true;
  }
  // Generic fallback: `attr=value` token where the lower-cased KEY
  // matches the XML attr name. Most attrs follow this convention.
  const lowerAttr = attr.toLowerCase();
  return tokens.some((t) => {
    const eq = t.indexOf('=');
    if (eq <= 0) return false;
    return t.slice(0, eq).toLowerCase() === lowerAttr;
  });
}

/**
 * Sorted list of attribute keys at `currentStep` whose values match
 * `prevStep`'s same-key value AND were NOT explicitly written by the
 * user on `currentStep`'s $EST line. Kept for backward compat /
 * tests; the unified `classifyEstStep` is the new entry point.
 */
export function findPropagatedKeys(
  currentStep: EstimationOptionsStep,
  prevStep: EstimationOptionsStep | null,
  tokens: readonly string[],
): string[] {
  if (!prevStep) return [];
  const nonDefault = new Set(findNonDefaultKeys(currentStep));
  const out: string[] = [];
  for (const k of nonDefault) {
    if (userWroteAttr(k, tokens)) continue;
    if (prevStep[k] !== undefined && prevStep[k] === currentStep[k]) {
      out.push(k);
    }
  }
  return out.sort();
}

/**
 * Per-attr tier in the new (v0.0.181+) coloring scheme:
 *   - `explicit`        : user typed this attr on the current $EST line.
 *                         Renders blue. Whether it overwrites the default
 *                         doesn't matter — the user's intent IS the signal.
 *   - `explicitDefault` : user typed it AND value matches the method
 *                         baseline default. Renders blue + italic so the
 *                         user can tell their explicit value was "no-op".
 *   - `implicit`        : user did NOT type it AND value differs from
 *                         baseline. Set by AUTO=N's per-method overrides
 *                         OR propagated from a prior $EST step. Renders
 *                         orange — visually flags "I didn't pick this,
 *                         NM did, and it's not the default".
 *
 * Keys that match the baseline default AND were not user-typed are
 * omitted from the result (render unstyled).
 */
export type EstTier = 'explicit' | 'explicitDefault' | 'implicit';

/**
 * Identity-style attrs that don't fit the explicit/implicit/default
 * model — `estimation_method` is informational; `cinterval` cascades
 * from PRINT; `etas_fixed_to_zero` is HYBRID-only and only emits when
 * user supplied via ZERO=. Render unstyled even when present.
 *
 * `file` is NOT in this set: NM's default is `<modelname>.ext`
 * (per-run-derived), and a value like `psn.ext` is a strong signal
 * that PsN's execute wrapper rewrote it — worth flagging implicit.
 */
const SKIP_TIER_KEYS: ReadonlySet<string> = new Set([
  'estimation_method',
  'cinterval',
  'etas_fixed_to_zero',
]);

/**
 * Single-pass classifier producing the tier-map for a `$EST` step.
 * Tier semantics encode "did the user type this on the current step's
 * $EST line, and does the resulting value differ from the bare-method
 * default?". See `EstTier` for tier meanings.
 *
 * `tokens` are the user's verbatim tokens from the .lst echo (empty
 * when no .lst available — degrades gracefully: everything becomes
 * implicit-or-default).
 *
 * `expectedDefaultFile` is the NM-derived default for the `file` attr
 * (`<modelname>.ext`). Computed payload-side from the lst path. When
 * null, `file` falls back to the static baseline (and may false-flag
 * as implicit; preferable to silent miss).
 */
export function classifyEstStep(
  step: EstimationOptionsStep,
  tokens: readonly string[],
  expectedDefaultFile: string | null = null,
): Record<string, EstTier> {
  const defaults = findDefaultsForStep(step) || {};
  const out: Record<string, EstTier> = {};
  for (const k of Object.keys(step)) {
    if (SKIP_TIER_KEYS.has(k)) continue;
    const value = step[k];
    const wroteIt = userWroteAttr(k, tokens);
    // Treat absent baseline (NM 7.7+ unknown attr, contextual emit)
    // as "differs from default" — surfaces the gap to a maintainer.
    let matchesDefault: boolean;
    if (k === 'file') {
      // NM's default file is <modelname>.ext, derived per-run. The
      // payload-builder computes this from the lst path. Comparing
      // the static baseline 'run001.ext' would mis-flag every run
      // whose model isn't named run001.
      matchesDefault = expectedDefaultFile !== null && expectedDefaultFile === value;
    } else {
      matchesDefault = defaults[k] !== undefined && defaults[k] === value;
    }
    if (wroteIt && matchesDefault) {
      out[k] = 'explicitDefault';
    } else if (wroteIt) {
      out[k] = 'explicit';
    } else if (!matchesDefault) {
      out[k] = 'implicit';
    }
    // matches default + not typed → omit (unstyled)
  }
  return out;
}
