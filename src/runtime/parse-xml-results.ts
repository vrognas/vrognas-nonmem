// Extract per-`$EST`-step result fields from a NONMEM `.xml` report.
// Each `<nm:estimation nm:number='N' nm:type='T'>...</nm:estimation>`
// block holds fields that the .lst echoes only partially (typically
// just for the LAST step) -- in particular per-step timing and the
// numeric termination_status code. .ext also has termination codes
// (in its `-1000000007` row) but does not carry burn-in vs accumulation
// timing breakdown.
//
// Same regex-extraction approach as `parse-xml-options.ts`: the fields
// we need are flat text-content of named elements. When we later
// graduate to structured parsing of `<nm:estimation_results>` etc.,
// adopt fast-xml-parser then.

export interface EstimationStepResult {
  /** Step number from `nm:number='N'` on the `<nm:estimation>` open tag. 1-based, matches chained-$EST order. */
  number: number;
  /**
   * `<nm:termination_status>N</nm:termination_status>`. NONMEM 7 codes:
   *   0 = minimum successfully found
   *   1 = minimization successful but rounding errors near the minimum
   *   2 = minimization failed (failed precision)
   *   3 = numerical instability or max evals reached
   *   4+ = various failure modes (hessian non-PD, user-aborted, etc.)
   * Null when the element is absent (older NM, run aborted before
   * termination block was written).
   */
  terminationStatus: number | null;
  /**
   * `<nm:estimation_burnin_time>` in seconds — only emitted for
   * methods with a burn-in phase (SAEM, BAYES). Null for FOCE / IMP /
   * IMP-EONLY blocks where there's no burn-in concept.
   */
  burninTime: number | null;
  /** `<nm:estimation_elapsed_time>` in seconds — total time for this step. */
  elapsedTime: number | null;
}

/**
 * Parse all `<nm:estimation>...</nm:estimation>` blocks. Returns `[]`
 * when the XML lacks the element (older NM, run aborted before
 * report was written). Never throws.
 */
export function parseEstimationResults(xmlText: string): EstimationStepResult[] {
  const out: EstimationStepResult[] = [];
  // Block delimiter: open tag through matching close. Body multi-line,
  // hence `[\s\S]*?` non-greedy.
  const blockRe = /<nm:estimation\b([^>]*)>([\s\S]*?)<\/nm:estimation>/g;
  for (const m of xmlText.matchAll(blockRe)) {
    const openAttrs = m[1];
    const body = m[2];
    const number = readIntAttr(openAttrs, 'number');
    out.push({
      number: number ?? out.length + 1,
      terminationStatus: readIntElement(body, 'termination_status'),
      burninTime: readFloatElement(body, 'estimation_burnin_time'),
      elapsedTime: readFloatElement(body, 'estimation_elapsed_time'),
    });
  }
  return out;
}

function readIntAttr(snippet: string, name: string): number | null {
  const re = new RegExp(`nm:${name}\\s*=\\s*['"]([^'"]*)['"]`);
  const m = snippet.match(re);
  if (!m) return null;
  const v = parseInt(m[1], 10);
  return Number.isFinite(v) ? v : null;
}

function readIntElement(body: string, tag: string): number | null {
  const re = new RegExp(`<nm:${tag}>\\s*(-?\\d+)\\s*</nm:${tag}>`);
  const m = body.match(re);
  if (!m) return null;
  const v = parseInt(m[1], 10);
  return Number.isFinite(v) ? v : null;
}

function readFloatElement(body: string, tag: string): number | null {
  const re = new RegExp(`<nm:${tag}>\\s*([+-]?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\s*</nm:${tag}>`);
  const m = body.match(re);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}
