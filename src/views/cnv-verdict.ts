// cnv-verdict — classify a `.cnv` table into a per-EM-step convergence
// verdict for the inspector meta-line. Surfaces facts (per-param p vs
// α, OFV p vs OFV α), no editorialising.
//
// "Converged" definition from NONMEM convergence-test docs: each
// element with α > 0 must have `p ≥ α`. The OFV column uses the
// uncorrected α (default 0.05); per-parameter α values are
// Bonferroni-corrected by NONMEM itself (the .cnv `-2000000003` row
// holds the as-applied α for each).
//
// Edge cases:
//   - Off-diagonal OMEGA(i,j) on a diagonal $OMEGA: structurally
//     constant zero, so the slope p-value is 1.0 by construction.
//     These count as trivially-converged.
//   - α = 0 on any column: NONMEM was instructed not to test that
//     parameter (CTYPE excluded it). The verdict treats it as
//     "not tested" and excludes from converged/total counts.

import type { CnvTable } from '../runtime/parse-cnv';
import { pickOfvColumn } from '../runtime/parse-table-header';

export interface CnvVerdict {
  /** True when both OFV and every tested param meet `p ≥ α`. */
  converged: boolean;
  /** OFV column's p-value. */
  ofvP: number;
  /** OFV column's α (uncorrected, typically 0.05). */
  ofvAlpha: number;
  /** Number of tested non-OFV params (α > 0) that met `p ≥ α`. */
  paramConverged: number;
  /** Number of tested non-OFV params (α > 0). */
  paramTotal: number;
  /** Names of tested params that did NOT meet `p ≥ α`. Empty when all converged. */
  nonConvergedParams: string[];
}

/**
 * Compute the verdict from the last `.cnv` table. Returns null when:
 *   - `table` is null (no .cnv loaded).
 *   - `table` has no OFV column (must be at least 1 param).
 *   - p-values or alphas arrays are missing/short — degraded data.
 */
export function classifyCnv(table: CnvTable | null): CnvVerdict | null {
  if (!table) return null;
  const n = table.paramNames.length;
  if (n === 0 || table.pValues.length !== n || table.alphas.length !== n) return null;

  // Locate the OFV column by `/OBJ$/i` name pattern (matches NM7's
  // SAEMOBJ / IMPOBJ / BAYESOBJ / OBJ); falls back to last column
  // when no match (defensive — empirically the OFV is always last).
  // Bail when α ≤ 0 (NONMEM wasn't asked to test it — `p ≥ 0` would
  // be vacuously true and give a false-positive "converged" verdict).
  const ofvIdx = pickOfvColumn(table.paramNames);
  const ofvCol = ofvIdx >= 0 ? ofvIdx : n - 1;
  const ofvP = table.pValues[ofvCol];
  const ofvAlpha = table.alphas[ofvCol];
  if (!Number.isFinite(ofvP) || !Number.isFinite(ofvAlpha) || ofvAlpha <= 0) return null;

  const nonConvergedParams: string[] = [];
  let paramTotal = 0;
  let paramConverged = 0;
  for (let i = 0; i < n; i++) {
    if (i === ofvCol) continue; // OFV handled above
    const p = table.pValues[i];
    const a = table.alphas[i];
    if (!Number.isFinite(p) || !Number.isFinite(a) || a <= 0) continue; // not tested
    paramTotal++;
    if (p >= a) {
      paramConverged++;
    } else {
      nonConvergedParams.push(table.paramNames[i]);
    }
  }

  // Require at least one tested non-OFV parameter — when CTYPE=0 globally
  // (all α ≤ 0), paramTotal===0 and the OFV-only "p ≥ α" check alone isn't
  // a full convergence verdict; flagging green would be misleading.
  const converged = ofvP >= ofvAlpha && nonConvergedParams.length === 0 && paramTotal > 0;
  return { converged, ofvP, ofvAlpha, paramConverged, paramTotal, nonConvergedParams };
}
