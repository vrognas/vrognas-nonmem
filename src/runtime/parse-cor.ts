import { parseFortranNumber } from './parse-fortran-number';
import { parseTableBlocks } from './parse-table-blocks';

// parseCor — read NONMEM `.cor` (correlation matrix of estimates).
//
// NONMEM 7+ `.cor` layout (multi-table when multiple $EST steps; same
// last-step-wins rule as parse-ext-fit / parse-phi):
//
//   TABLE NO.     N: <method>: Problem=… Subproblem=… …
//    NAME         THETA1       SIGMA(1,1)   OMEGA(1,1)
//    THETA1        1.00000E+00  4.20000E-01 -1.50000E-01
//    SIGMA(1,1)    4.20000E-01  1.00000E+00  3.10000E-02
//    OMEGA(1,1)   -1.50000E-01  3.10000E-02  1.00000E+00
//
// Format details:
//   - Column header line begins with `NAME` followed by parameter names
//     in NONMEM's emit order (typically TSO — THETA, SIGMA, OMEGA — for
//     `.cor`; differs from `.ext` default TOS, so we read names from the
//     header rather than assume).
//   - Each data row starts with the parameter name, then N numeric values.
//   - Full square matrix (not lower-triangular). Diagonal = 1.0 in a
//     real run; all-zero entries indicate $COV failed/skipped (NONMEM
//     emits the matrix shape but fills with sentinels — same convention
//     as `.ext` zeros for SE).
//   - Multi-line continuations not observed in practice for `.cor`
//     (param list is typically short enough to fit on one line); we
//     support them anyway by accepting any row whose first token isn't
//     a known parameter name as a continuation of the prior row.
//     ACTUALLY — keeping this simple for now: assume one row per param,
//     no continuation lines. Empirically the realistic param counts
//     (5-30) all fit on one line in NM7 default `s1PE15.8` format.

export interface CorTable {
  /** Method label parsed from `TABLE NO. N: <method>:` header. */
  method: string;
  /** Parameter names in the order they appear on the header row. */
  paramNames: string[];
  /**
   * Symmetric correlation matrix, keyed by parameter name on both axes.
   * `values.get(a)!.get(b)` returns corr(a, b). Diagonal = 1.0 in a
   * well-formed run; all-zero matrix indicates $COV did not produce a
   * COR matrix (failed/skipped). Inner Map preserves insertion order
   * matching `paramNames`.
   */
  values: Map<string, Map<string, number>>;
}

/**
 * Parse a `.cor` file into one entry per `TABLE NO.` block. Returns an
 * empty array if no tables are recognised (truncated file, non-cor
 * input, etc.). Never throws.
 */
export function parseCor(text: string): CorTable[] {
  return parseTableBlocks(text, (l) => /^NAME\b/i.test(l)).map((b) => {
    const paramNames = b.headerTokens ? b.headerTokens.slice(1) : [];
    const values = new Map<string, Map<string, number>>();
    for (const name of paramNames) values.set(name, new Map());
    for (const line of b.rowLines) {
      // Data row: first token is a parameter name (or a continuation —
      // skipped here, see header comment), rest are numeric correlations.
      const tokens = line.split(/\s+/);
      const rowMap = values.get(tokens[0]);
      if (!rowMap) continue; // unrecognised row name — skip silently
      for (let i = 0; i < paramNames.length && i + 1 < tokens.length; i++) {
        const v = parseFortranNumber(tokens[i + 1]);
        if (Number.isFinite(v)) rowMap.set(paramNames[i], v);
      }
    }
    return { method: b.method, paramNames, values };
  });
}

/** Convenience: return the last (final $EST step) table, or null. */
export function lastCorTable(text: string): CorTable | null {
  const tables = parseCor(text);
  return tables.length > 0 ? tables[tables.length - 1] : null;
}

