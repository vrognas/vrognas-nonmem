// Extract `<nm:estimation_options nm:knob='value' ... />` elements from
// a NONMEM `.xml` report (NM 7.2+, on by default; suppressed only with
// `nmfe76 -xmloff`). The XML carries the **exhaustive** list of $EST
// options actually used for each chained step -- the .lst's
// `<nm:estimation_information>` echo is a human-readable subset of the
// same data, formatted for reading.
//
// We use a focused regex extractor rather than pulling in an XML
// parser dependency: the element is self-closing with simple
// attribute pairs, and we only care about extracting the attribute
// dictionary. ~30 LOC vs ~50 KB of dep. If we later need nested-
// element parsing (e.g. estimation_results), graduate to
// fast-xml-parser at that point.

/**
 * One step's worth of `nm:*` attributes from an `<nm:estimation_options/>`
 * element. Keys have the `nm:` prefix stripped; values are kept as
 * strings (typed parsing is the consumer's job -- `'1000'` for `nburn`
 * vs `'5.000000000000000E-02'` for `calpha`).
 */
export type EstimationOptionsStep = Record<string, string>;

/**
 * Parse all `<nm:estimation_options ... />` elements in chained-`$EST`
 * order. Returns `[]` when the XML lacks the element (older NM, run
 * aborted before the report block was written, etc.). Never throws.
 */
export function parseEstimationOptions(xmlText: string): EstimationOptionsStep[] {
  // Self-closing element: `<nm:estimation_options ... />`. The body
  // can span multiple lines (NONMEM wraps long attr lists), so the
  // capture group accepts any char that isn't a `>` (so we don't run
  // past the closing `/>`). Tightened from `[\s\S]*?`: with the
  // non-greedy form, an attribute value containing `/>` (hypothetical
  // — NM7 doesn't emit such values empirically, but defensive) would
  // terminate the match prematurely. With `[^>]*?` the regex fails
  // cleanly on that input rather than capturing a truncated body.
  const blockRe = /<nm:estimation_options\b([^>]*?)\/>/g;
  const out: EstimationOptionsStep[] = [];
  for (const m of xmlText.matchAll(blockRe)) {
    out.push(parseAttrs(m[1]));
  }
  return out;
}

/**
 * Extract `nm:key='value'` (or `"value"`) pairs from a snippet of XML
 * attribute text. Strips the `nm:` prefix from keys.
 */
function parseAttrs(snippet: string): EstimationOptionsStep {
  const attrs: EstimationOptionsStep = {};
  const attrRe = /nm:([A-Za-z_][\w-]*)\s*=\s*(?:'([^']*)'|"([^"]*)")/g;
  for (const m of snippet.matchAll(attrRe)) {
    attrs[m[1]] = m[2] ?? m[3] ?? '';
  }
  return attrs;
}
