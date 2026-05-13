// xml-invisible-attrs.js — pure config + pure functions for the
// invisible $EST / $COV attribute synthesis pipeline. Loaded BEFORE
// `client.js` via the inspector HTML; functions and constants are
// top-level globals (same model as `formatters.js` / `transforms.js`).
//
// Scope:
//   - `INVISIBLE_ATTR_DEFS` / `INVISIBLE_ATTR_DEFAULTS` / `INVISIBLE_ATTR_PATTERNS`
//     — per-attr defaults, applicability rules, and user-token regexes.
//   - `INVISIBLE_COV_DEFAULTS` / `INVISIBLE_COV_PATTERNS` — same for $COV.
//   - `synthesizeFromTokens`, `synthesizeInvisibleAttrs`, `synthesizeInvisibleCovAttrs`
//     — walk user tokens + emit `{value, isUserSet, inapplicable}` rows.
//   - `attrAppliesToContext` — method + $LEVEL gating.
//   - `extractValue` — pattern-descriptor → value extraction.
//   - `resolveEstAttrFromLst` / `resolveCovAttrFromLst` — wire-sentinel →
//     runtime-resolved value (e.g. atol='0' → '12' from .lst trace).
//   - `INVISIBLE_TOKEN_PATTERNS` / `isInvisibleToken` — tokens skipped
//     in the user-vs-XML comparison (currently just NOSORT).
//
// All exports stay on `globalThis` for the WebView; dual-mode
// `module.exports` block at the bottom for unit tests.

// Tokens NM never emits in the XML even when user explicitly sets them,
// AND that we don't synthesize as their own attr row. PRINT, POSTHOC,
// ETABARCHECK, NUMERICAL, CENTERING are all synthesized via
// `synthesizeInvisibleAttrs` so they show up as proper rows. NOSORT
// remains here because SORT emits visible `objsort='yes'` (so the user
// can see the explicit case in the main table); only the NO-prefix /
// default state would otherwise be invisible.
const INVISIBLE_TOKEN_PATTERNS = [
  /^N?O?SORT$/i,
];

function isInvisibleToken(token) {
  return INVISIBLE_TOKEN_PATTERNS.some((re) => re.test(token));
}

/**
 * Doc-default values for $EST options that NM never emits to XML, plus
 * their method-applicability per Bauer's $EST docs. `applicable` is a
 * set of method-kind labels — `'all'` means universal. Empirically
 * verified universal at probe-attrs-survey/ where probes ran with FOCE.
 *
 * Method-conditional applicability (per Bauer's docs):
 *   - PRINT, POSTHOC, ETABARCHECK: universal (per user's all-methods list)
 *   - NUMERICAL: Laplacian-only (line 2935: "for the Laplacian method")
 *   - CENTERING: FOCE-only (line 2380: "May only be used with METHOD=1")
 *   - PARAFILE, PARAFPRINT, FPARAFILE: universal (parallel-processing knobs)
 */
// `applicable` semantics: either the string 'all' (universal), or a
// Set-like array of MethodKind labels (see xml-est-defaults.ts). POSTHOC
// applies to FO and to MAXEVAL=0 evaluation runs of classical-conditional
// methods per Bauer line 3082 — the latter is the 'foce-eval' method kind.
const INVISIBLE_ATTR_DEFS = {
  print:        { default: '9999', applicable: 'all' },
  posthoc:      { default: 'no',   applicable: ['fo', 'foce-eval'] },
  etabarcheck:  { default: 'no',   applicable: 'all' },
  numerical:    { default: 'no',   applicable: ['laplace'] },
  centering:    { default: 'no',   applicable: ['foce'] },
  parafile:     { default: 'OFF',  applicable: 'all' },
  parafprint:   { default: '1',    applicable: 'all' },
  fparafile:    { default: 'OFF',  applicable: 'all' },
  // LEVCENTER/LEVOBJTYPE/LEVWT require $LEVEL record. Bauer says
  // "There is no default. Required with $LEVEL and $ESTIMATION" — so we
  // show empty value when $LEVEL present + user didn't type.
  levcenter:    { default: '',     applicable: 'all', requiresLevel: true },
  levobjtype:   { default: '',     applicable: 'all', requiresLevel: true },
  levwt:        { default: '',     applicable: 'all', requiresLevel: true },
};

// Convenience: doc defaults indexed by attr name, for tooltip lookups.
const INVISIBLE_ATTR_DEFAULTS = Object.fromEntries(
  Object.entries(INVISIBLE_ATTR_DEFS).map(([k, v]) => [k, v.default]),
);

/**
 * Pattern list per invisible attr (v0.0.191+ unified shape, used for
 * both $EST and $COV). Each attr maps to one-or-more pattern
 * descriptors `{re, extract}`. `extract` is one of:
 *   - `'kv'`      → user-token is KEY=VALUE; extract the RHS.
 *   - `'toggle'`  → token may have a NO- prefix; matched flag → 'no'
 *                   if prefix present, 'yes' otherwise.
 *   - literal str → the matched token unconditionally sets the attr
 *                   to this fixed value (e.g. SPECIAL → 'yes',
 *                   UNCONDITIONAL → 'no').
 * First matching pattern in the list wins.
 */
const INVISIBLE_ATTR_PATTERNS = {
  print:       [{ re: /^PRINT=/i, extract: 'kv' }],
  posthoc:     [{ re: /^(NO)?POSTHOC$/i, extract: 'toggle' }],
  etabarcheck: [{ re: /^(NO)?ETABARCHECK$/i, extract: 'toggle' }],
  numerical:   [{ re: /^(NO)?NUMERICAL$/i, extract: 'toggle' }],
  centering:   [{ re: /^(NO)?CENTERING$/i, extract: 'toggle' }],
  parafile:    [{ re: /^PARAFILE=/i, extract: 'kv' }],
  parafprint:  [{ re: /^PARAFPRINT=/i, extract: 'kv' }],
  fparafile:   [{ re: /^FPARAFILE=/i, extract: 'kv' }],
  levcenter:   [{ re: /^LEVCENTER=/i, extract: 'kv' }],
  levobjtype:  [{ re: /^LEVOBJTYPE=/i, extract: 'kv' }],
  levwt:       [{ re: /^LEVWT=/i, extract: 'kv' }],
};

// Doc-default values for $COV options that NM never (or conditionally)
// emits to XML. Boolean-toggle pairs use the NMTRAN `[FLAG|NOFLAG]`
// convention.
//
// `special` is a conditional case — bare $COV emits cov_special='no'
// (visible), but `$COV MATRIX=R` SUPPRESSES it from XML emission
// (empirically verified at probe-cov-survey/matrix_r, NM 7.6.0). The
// synthesis is additive (only adds when XML doesn't carry the key) so
// we surface SPECIAL even when MATRIX=R hides it. Bauer's doc warning
// "MATRIX=R should not be used with SPECIAL" is reflected via a tooltip
// annotation on the synthesized row.
const INVISIBLE_COV_DEFAULTS = {
  conditional: 'yes',     // CONDITIONAL is default; UNCONDITIONAL is the toggle
  parafile: 'OFF',        // PARAFILE=OFF default per Bauer
  parafprint: '1',        // PARAFPRINT=1 default
  special: 'no',          // suppressed from XML when MATRIX=R; surface here
};

// Same `INVISIBLE_ATTR_PATTERNS` shape as $EST. First-match wins.
// CONDITIONAL/UNCONDITIONAL share the `conditional` attr (toggle pair
// with explicit values rather than NO-prefix).
const INVISIBLE_COV_PATTERNS = {
  conditional: [
    { re: /^CONDITIONAL$/i, extract: 'yes' },
    { re: /^UNCONDITIONAL$/i, extract: 'no' },
  ],
  parafile:   [{ re: /^PARAFILE=/i, extract: 'kv' }],
  parafprint: [{ re: /^PARAFPRINT=/i, extract: 'kv' }],
  special:    [{ re: /^SPECIAL$/i, extract: 'yes' }],
};

/**
 * Whether a synthesised attr applies to the given context (method +
 * model features). Returns false when:
 *   - the attr's method-applicability doesn't match (e.g. CENTERING
 *     when methodKind is 'em')
 *   - the attr requires $LEVEL but the model has no $LEVEL record
 * `methodKind` is the canonical 5-way label from
 * `xml-est-defaults.ts:MethodKind`, shipped per-step on the payload as
 * `xmlEstimationMethodKinds[i]`.
 */
function attrAppliesToContext(attr, methodKind, hasLevel) {
  const def = INVISIBLE_ATTR_DEFS[attr];
  if (!def) return true;
  if (def.requiresLevel && !hasLevel) return false;
  if (def.applicable === 'all') return true;
  // applicable is an array of allowed method-kinds.
  return def.applicable.indexOf(methodKind) !== -1;
}

/**
 * Generic synthesis walker. For each attr in `attrPatterns`, scan user
 * tokens for a matching pattern. First match wins. Produces
 * `{value, isUserSet, inapplicable}` entries when the attr applies to
 * the current context OR was user-typed. Additive-by-construction:
 * skips attrs already present in `existingKeys`.
 */
function synthesizeFromTokens(userTokens, attrPatterns, appliesFn, defaultsMap, existingKeys) {
  const out = {};
  for (const [attr, patternList] of Object.entries(attrPatterns)) {
    if (existingKeys && existingKeys.has(attr)) continue;
    const applies = appliesFn(attr);
    let matched = null;
    for (const p of patternList) {
      const match = userTokens.find((t) => p.re.test(t));
      if (match) {
        matched = { value: extractValue(match, p.extract), isUserSet: true, inapplicable: !applies };
        break;
      }
    }
    if (matched) {
      out[attr] = matched;
    } else if (applies) {
      out[attr] = { value: defaultsMap[attr], isUserSet: false, inapplicable: false };
    }
    // else: not user-typed AND inapplicable → skip the row.
  }
  return out;
}

/**
 * Extract the synthesised value from a matched user token per the
 * pattern descriptor's `extract` field. See `INVISIBLE_ATTR_PATTERNS`
 * for the supported flavours.
 */
function extractValue(match, extract) {
  if (extract === 'kv') return match.split('=')[1] || '';
  if (extract === 'toggle') return /^NO/i.test(match) ? 'no' : 'yes';
  return extract; // literal string
}

/**
 * Build a synthetic-attr overlay for the $EST step from user tokens.
 * Method-conditional attrs (NUMERICAL/CENTERING) are skipped when
 * inapplicable AND not user-typed; user-typed-inapplicable surfaces
 * with `inapplicable: true` for the renderer's WARNING tooltip.
 * Additive-by-construction: `existingKeys` are XML-emitted attrs that
 * the synthesis must not clobber (NM 7.7+ may emit attrs we currently
 * treat as invisible).
 */
function synthesizeInvisibleAttrs(userTokens, methodKind, hasLevel, existingKeys) {
  const applies = (attr) => attrAppliesToContext(attr, methodKind, hasLevel);
  return synthesizeFromTokens(
    userTokens,
    INVISIBLE_ATTR_PATTERNS,
    applies,
    INVISIBLE_ATTR_DEFAULTS,
    existingKeys,
  );
}

/**
 * Build a synthetic-attr overlay for the $COV step. Surfaces options
 * NM never emits to XML (CONDITIONAL, PARAFILE, PARAFPRINT) plus
 * `special` (conditionally emitted: suppressed when MATRIX=R per NM
 * 7.6.0 empirical). `existingKeys` makes the merge additive — keys
 * already in XML are skipped, so XML-emitted values always win over
 * synthesised defaults.
 */
function synthesizeInvisibleCovAttrs(covTokens, existingKeys) {
  // All $COV invisibles currently apply unconditionally; method/level
  // gating not needed today.
  const applies = () => true;
  return synthesizeFromTokens(
    covTokens,
    INVISIBLE_COV_PATTERNS,
    applies,
    INVISIBLE_COV_DEFAULTS,
    existingKeys,
  );
}

/**
 * Map a `<nm:estimation_options>` attr to its runtime-resolved value.
 * Prefers the `.lst` trace (most authoritative — reflects the actual
 * runtime value after $EST/$SUBROUTINES overrides). Falls back to the
 * documented Bauer default when the trace is absent (non-ODE models
 * don't emit BASE/EST TOLERANCE blocks). Returns null when no
 * translation applies.
 *
 * Caveat for the fallback: a user-supplied `$SUBROUTINES ATOL=N`
 * override would not be detected without the .lst trace; the inspector
 * would show the doc default `12`. Better than leaking the sentinel.
 */
function resolveEstAttrFromLst(key, value, tolerances) {
  // atol='0' is the wire sentinel for "user didn't set on $EST".
  // Effective value: $SUBROUTINES ATOL (if set) → built-in default 12.
  if (key === 'atol' && value === '0') {
    return (tolerances && (tolerances.estAnrd || tolerances.baseAnrd)) || '12';
  }
  return null;
}

/**
 * Map a `<nm:problem_options>` cov_* attr to its runtime-resolved
 * value. Same trace-prefer-then-doc-fallback pattern as $EST. Returns
 * null when no translation applies.
 */
function resolveCovAttrFromLst(key, value, tolerances) {
  if (key === 'atol' && value === '-1') {
    // cov_atol='-1' inherits from $EST atol (and chain → $SUBROUTINES →
    // built-in 12). Use covAnrd from .lst trace when available; else
    // fall back to the documented Bauer default.
    return (tolerances && tolerances.covAnrd) || '12';
  }
  if (key === 'tol' && value === '-1') {
    return tolerances && tolerances.covNrd;
  }
  return null;
}

// Dual-mode export: WebView ignores (`module` is undefined in browsers,
// guard prevents ReferenceError); Node / vitest sees the exports for
// unit testing. We also mirror everything onto `globalThis` in Node so
// sibling files imported as separate CJS modules (e.g. `client.js`)
// can resolve `INVISIBLE_ATTR_DEFAULTS` etc. by name — the WebView
// gets that for free via the shared script-tag global scope.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    INVISIBLE_ATTR_DEFS,
    INVISIBLE_ATTR_DEFAULTS,
    INVISIBLE_ATTR_PATTERNS,
    INVISIBLE_COV_DEFAULTS,
    INVISIBLE_COV_PATTERNS,
    INVISIBLE_TOKEN_PATTERNS,
    attrAppliesToContext,
    extractValue,
    isInvisibleToken,
    resolveCovAttrFromLst,
    resolveEstAttrFromLst,
    synthesizeFromTokens,
    synthesizeInvisibleAttrs,
    synthesizeInvisibleCovAttrs,
  };
  Object.assign(globalThis, module.exports);
}
