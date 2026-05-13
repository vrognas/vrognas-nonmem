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

import { parseExtBlocks } from './parse-ext-tokenizer';

export interface ExtTrajectory {
  /** Method label parsed from the `TABLE NO.` header. */
  method: string;
  /** Column names in emit order, including the trailing OFV column (e.g. `OBJ`, `SAEMOBJ`). */
  paramNames: string[];
  /** Iteration numbers, parallel to each `values[name][i]`. */
  iterations: number[];
  /**
   * `paramName -> [values per iteration]`, parallel to `iterations`.
   * Non-finite tokens in the source `.ext` (rare — typically only the
   * `1.79E+308` sentinel NONMEM emits for OBJ in early iterations) are
   * pushed as `NaN` so the array stays the same length as `iterations`
   * (parallel-array invariant). Consumers MUST filter non-finite values
   * before computing aggregates (`Math.min` / `Math.max` propagate NaN;
   * sparkline rendering already does this filtering in `renderSparkline`).
   */
  values: Map<string, number[]>;
}

/** Parse all per-iteration trajectories from a `.ext` text. */
export function parseExtTrajectory(text: string): ExtTrajectory[] {
  const blocks = parseExtBlocks(text);
  const out: ExtTrajectory[] = [];
  for (const block of blocks) {
    if (!block.header) continue; // truncated block — skip
    const traj: ExtTrajectory = {
      method: block.method,
      paramNames: block.header,
      iterations: [],
      values: new Map(),
    };
    for (const name of block.header) traj.values.set(name, []);
    for (const { iter, tokens } of block.rows) {
      // Skip the negative-marker rows used for finals / SEs / eigvals
      // / etc. They live in the same table block but aren't trajectory
      // data — anything <= -1e9 is a marker.
      if (iter <= -1_000_000_000) continue;
      if (tokens.length !== block.header.length) continue;
      traj.iterations.push(iter);
      for (let i = 0; i < block.header.length; i++) {
        const v = Number(tokens[i]);
        traj.values.get(block.header[i])!.push(Number.isFinite(v) ? v : NaN);
      }
    }
    out.push(traj);
  }
  // Drop empty trajectories (header-only blocks from a truncated .ext).
  return out.filter((t) => t.iterations.length > 0);
}
