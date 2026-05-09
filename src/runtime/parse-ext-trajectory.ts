// parseExtTrajectory — extract per-iteration parameter + OFV trajectories
// from a NONMEM `.ext`. Distinct from `parseExtFit` (which keeps only
// the final-estimates / SE / etc. negative-marker rows): this parser
// retains every PRINT'd iteration row so the inspector can render
// convergence sparklines.
//
// One trajectory per `TABLE NO.` block (chained `$EST` records emit
// one block each). We return them in order; callers typically render
// each block as its own labelled set of sparklines.
//
// Iteration column is signed: SAEM/IMP/BAYES burn-in iterations are
// negative (counting up to 0), accumulation iterations are positive.
// We preserve the sign so the renderer can show a burn-in -> accumulation
// transition line.
//
// Negative-marker rows (-1000000000, -1000000001, …) used by parseExtFit
// for final estimates / SEs are filtered out — they aren't trajectory
// data points.

import { extractTableMethod } from './parse-table-header';

export interface ExtTrajectory {
  /** Method label parsed from the `TABLE NO.` header. */
  method: string;
  /** Column names in emit order, including the trailing OFV column (e.g. `OBJ`, `SAEMOBJ`). */
  paramNames: string[];
  /** Iteration numbers, parallel to each `values[name][i]`. */
  iterations: number[];
  /** `paramName -> [values per iteration]`, parallel to `iterations`. */
  values: Map<string, number[]>;
}

/** Parse all per-iteration trajectories from a `.ext` text. */
export function parseExtTrajectory(text: string): ExtTrajectory[] {
  const tables: ExtTrajectory[] = [];
  let current: ExtTrajectory | null = null;
  let header: string[] | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^TABLE\s+NO\b/i.test(line)) {
      if (current) tables.push(current);
      current = {
        method: extractTableMethod(line),
        paramNames: [],
        iterations: [],
        values: new Map(),
      };
      header = null;
      continue;
    }

    if (!current) continue;

    if (/^ITERATION\b/i.test(line)) {
      // Header row: drop the leading "ITERATION", keep the rest as
      // parameter columns. Rewrite NONMEM's `THETA1` -> `THETA(1)` to
      // match the access-key convention used everywhere else in the
      // codebase (mirrors parseExtFit's normalisation).
      const tokens = line.split(/\s+/).slice(1);
      header = tokens.map(normalizeName);
      current.paramNames = header;
      for (const name of header) current.values.set(name, []);
      continue;
    }

    if (!header) continue;

    const tokens = line.split(/\s+/);
    const iter = Number(tokens[0]);
    if (!Number.isFinite(iter)) continue;
    // Skip the negative-marker rows used for finals / SEs / eigvals
    // / etc. They live in the same table block but aren't trajectory
    // data — anything <= -1e9 is a marker.
    if (iter <= -1_000_000_000) continue;
    if (tokens.length - 1 !== header.length) continue;

    current.iterations.push(iter);
    for (let i = 0; i < header.length; i++) {
      const v = Number(tokens[i + 1]);
      current.values.get(header[i])!.push(Number.isFinite(v) ? v : NaN);
    }
  }

  if (current) tables.push(current);
  // Drop empty trajectories (header-only blocks from a truncated .ext).
  return tables.filter((t) => t.iterations.length > 0);
}

/**
 * NONMEM writes `THETA1` (no parens) but our access-key convention is
 * `THETA(N)`. OMEGA/SIGMA already use `OMEGA(i,j)` form — leave those
 * alone. Mirrors `parseExtFit`'s normalisation so both modules emit
 * the same key set.
 */
function normalizeName(token: string): string {
  const m = token.match(/^THETA(\d+)$/i);
  return m ? `THETA(${m[1]})` : token;
}
