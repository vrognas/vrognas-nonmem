import { extractTableMethod } from './parse-table-header';

// parseCnv — read NONMEM `.cnv` (convergence info, NM 7.2+, written
// only when `$EST CTYPE > 0`).
//
// Layout (empirically verified against NM 7.6.0 SAEM run, 2026-05-08
// — see docs/empirical-notes.md "Signal-file mechanism" section):
//
//   TABLE NO.     1: Stochastic Approximation ...
//    ITERATION    THETA1       ...   OMEGA(4,4)   SAEMOBJ
//     -2000000000 9.81E-01     ...   4.30E-02     -37858.76    <- means
//     -2000000001 5.42E-03     ...   1.47E-04      107.85      <- SDs
//     -2000000002 9.20E-01     ...   4.99E-01      0.24004     <- p-values
//     -2000000003 5.68E-03     ...   5.68E-03      5.0E-02     <- alphas
//
// Notes:
//   - Header line begins with " ITERATION" then column names matching
//     the .ext layout (THETA<i> / SIGMA(i,j) / OMEGA(i,j)) plus the
//     OFV column at the end. We parse names from the header row.
//   - Per-parameter alpha is **Bonferroni-corrected** by NONMEM (e.g.
//     0.05 / 8.8 ≈ 0.00568 across 9 tested params). The OFV column
//     gets the **uncorrected** user CALPHA (0.05 by default).
//   - Off-diagonal OMEGAs that are structurally zero (diagonal $OMEGA)
//     show p=1.000 because their slope is constant; the verdict layer
//     treats those rows as trivially-converged and excludes them from
//     "not converged" counts.
//   - Convergence per parameter = `p ≥ α` element-wise. CTYPE choice
//     determines which parameters are tested (see CTYPE docs).
//   - Multi-table: one block per `$EST` step (same last-wins rule as
//     parse-cor / parse-ext-fit). For SAEM→IMP-EONLY chains, only the
//     SAEM step has CTYPE > 0 in practice; later $EST records emit
//     their own TABLE NO. block when their CTYPE > 0 but it's
//     uncommon. We expose `lastCnvTable` for the typical case.

export interface CnvTable {
  /** Method label parsed from `TABLE NO. N: <method>:` header. */
  method: string;
  /** Parameter names in header order; last entry is the OFV column (e.g. SAEMOBJ / IMPOBJ). */
  paramNames: string[];
  /** Means over the last CITER iterations, indexed parallel to paramNames. */
  means: number[];
  /** SDs over the last CITER iterations. */
  sds: number[];
  /** Linear-regression slope-vs-zero p-values per parameter; the OFV column is uncorrected. */
  pValues: number[];
  /** Per-parameter alpha threshold; Bonferroni-corrected for params, uncorrected for OFV. */
  alphas: number[];
}

/**
 * Parse a `.cnv` file into one entry per `TABLE NO.` block. Returns
 * an empty array when no recognisable block is present (file written
 * with CTYPE=0, truncated, non-cnv input). Never throws.
 */
export function parseCnv(text: string): CnvTable[] {
  const tables: CnvTable[] = [];
  let current: Partial<CnvTable> & { method: string } = { method: '' };
  let header: string[] | null = null;
  let inBlock = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^TABLE\s+NO\b/i.test(line)) {
      if (inBlock && header) finalize(tables, current as CnvTable);
      current = {
        method: extractTableMethod(line),
        paramNames: [],
        means: [],
        sds: [],
        pValues: [],
        alphas: [],
      };
      header = null;
      inBlock = true;
      continue;
    }

    if (!inBlock) continue;

    // Header row: starts with ITERATION, then param names. Only the
    // FIRST ITERATION row in a TABLE block sets the header — guard
    // against a stray re-occurrence stomping `paramNames` against
    // already-collected marker rows.
    if (!header && /^ITERATION\b/i.test(line)) {
      header = line.split(/\s+/).slice(1);
      current.paramNames = header;
      continue;
    }

    if (!header) continue;

    // Marker rows: first column is one of -2000000000..-2000000003.
    const tokens = line.split(/\s+/);
    const marker = tokens[0];
    const values = tokens.slice(1).map(Number);
    if (values.length !== header.length) continue;
    switch (marker) {
      case '-2000000000':
        current.means = values;
        break;
      case '-2000000001':
        current.sds = values;
        break;
      case '-2000000002':
        current.pValues = values;
        break;
      case '-2000000003':
        current.alphas = values;
        break;
      default:
        // Ignore non-marker rows (regular iteration data is theoretically
        // possible if NONMEM ever writes them here, though empirically
        // .cnv contains only the 4 marker rows).
        break;
    }
  }

  if (inBlock && header) finalize(tables, current as CnvTable);
  return tables;
}

/** Convenience: return the last $EST step's table, or null. */
export function lastCnvTable(text: string): CnvTable | null {
  const tables = parseCnv(text);
  return tables.length > 0 ? tables[tables.length - 1] : null;
}

function finalize(tables: CnvTable[], t: CnvTable): void {
  // Strict: only commit blocks where every marker row matches
  // header length. A degraded table (truncated mid-write, missing
  // alphas, etc.) is dropped here so downstream consumers can trust
  // every published `CnvTable` is fully populated.
  const n = t.paramNames.length;
  if (n < 2) return; // need at least one param + the OFV column
  if (
    t.means.length === n &&
    t.sds.length === n &&
    t.pValues.length === n &&
    t.alphas.length === n
  ) {
    tables.push(t);
  }
}
