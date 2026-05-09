// Extract `nm:cov_*` attributes from `<nm:problem_options ... />` in a
// NONMEM `.xml` report. NONMEM 7.6.0 does NOT emit a dedicated
// `<nm:covariance_options>` element (empirically probed at
// `~/positron-nonmem/probe-cov-*/run001.xml` on the host); instead the
// $COV record's options are folded into `<nm:problem_options>` as
// `nm:cov_<knob>` attribute pairs alongside `nm:data_*` and other
// problem-level metadata.
//
// The element is self-closing and lives once per problem (a single
// $COV record per problem in NONMEM, by design). Returns null when the
// XML lacks the element OR the element has no `cov_*` attrs (the
// latter signals "no $COV record at all" — distinct from `cov_omitted='yes'`
// which signals "$COV OMITTED" was explicitly written).

/**
 * Map of `nm:cov_<key>` → value. Keys have BOTH `nm:` and `cov_`
 * stripped, mirroring the EstimationOptionsStep convention so the
 * defaults table can match plain knob names (`matrix`, `thbnd`, etc.).
 */
export type CovarianceOptions = Record<string, string>;

/**
 * Parse the single `<nm:problem_options>` element's `cov_*` attrs.
 * Returns `null` if the element is missing OR carries no `cov_*` attrs
 * (model has no $COV record at all). Never throws.
 */
export function parseCovarianceOptions(xmlText: string): CovarianceOptions | null {
  // Self-closing, multi-line body. Same defensive `[^>]*?` body capture
  // as parse-xml-options.ts so a hypothetical attr value containing
  // `/>` fails cleanly rather than truncating. Non-global match — only
  // one `<nm:problem_options>` per problem, no need to materialise all.
  const blockMatch = xmlText.match(/<nm:problem_options\b([^>]*?)\/>/);
  if (!blockMatch) return null;
  const attrs: CovarianceOptions = {};
  // Match only `nm:cov_<key>='value'` (or `"value"`) — `nm:data_*` and
  // other problem-level metadata is filtered out at the regex level so
  // downstream code only sees $COV-specific knobs.
  const attrRe = /nm:cov_([A-Za-z_][\w-]*)\s*=\s*(?:'([^']*)'|"([^"]*)")/g;
  for (const a of blockMatch[1].matchAll(attrRe)) {
    attrs[a[1]] = a[2] ?? a[3] ?? '';
  }
  // No `cov_*` attrs → no $COV record. Distinct from `omitted='yes'`
  // (explicit user-written `$COV OMITTED`).
  if (Object.keys(attrs).length === 0) return null;
  return attrs;
}
