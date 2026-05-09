import { extractTableMethod, pickOfvColumn } from './parse-table-header';

// parsePhi — read PsN/NONMEM `.phi` for per-subject ETA estimates,
// conditional covariances, and individual OFV (iOFV).
//
// NONMEM 7 `.phi` layout (multi-table when multiple $EST steps):
//   TABLE NO.  N: <method>: Problem=… Subproblem=…
//    SUBJECT_NO   ID    PHI(1)  PHI(2)   PHC(1,1)  PHC(2,1)  PHC(2,2)   OBJ
//              1     1   <eta1> <eta2>   <var1>    <cov21>   <var2>     <iOFV>
//              2     2   …
//
// Columns:
//   - PHI(n)   : individual ETA estimates (one per OMEGA diagonal).
//   - PHC(i,j) : conditional covariance, lower-triangular (NETA × NETA).
//                Parsed past but not surfaced.
//   - OBJ      : per-subject contribution to the OFV (iOFV). Sum ≈ final
//                OFV (modulo the additive constant). Outliers in iOFV are
//                the "subjects driving the fit". Some methods name this
//                column `SAEMOBJ` instead; we treat the LAST numeric
//                column as iOFV regardless of header text.
//
// Last-table-wins rule (mirrors parse-ext-fit): caller usually wants the
// final $EST step's table; use `lastPhiTable(text)` for that.

export interface PhiRow {
  /** ID column value. Kept as the original token (some IDs are non-numeric strings). */
  id: number | string;
  /** PHI(1)..PHI(n), preserving order (matches OMEGA diagonal order). */
  etas: number[];
  /** Per-subject objective function contribution (last numeric column). null if absent. */
  iOfv: number | null;
}

export interface PhiTable {
  /** Method label parsed from `TABLE NO. N: <method>:` header. */
  method: string;
  rows: PhiRow[];
}

/**
 * Parse a `.phi` file into one entry per `TABLE NO.` block. Returns an
 * empty array if no tables are recognised. Never throws.
 */
export function parsePhi(text: string): PhiTable[] {
  const tables: PhiTable[] = [];
  let current: PhiTable | null = null;
  let header: string[] | null = null;
  let iOfvIdx = -1;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // New TABLE block — finalise the previous and start a fresh one.
    if (/^TABLE\s+NO\b/i.test(line)) {
      if (current) tables.push(current);
      current = { method: extractTableMethod(line), rows: [] };
      header = null;
      iOfvIdx = -1;
      continue;
    }

    // Header row: starts with SUBJECT_NO, contains PHI(...) columns.
    if (/^SUBJECT_NO\b/i.test(line)) {
      header = line.split(/\s+/);
      iOfvIdx = pickOfvColumn(header);
      continue;
    }

    // Data row: leading token must be numeric (subject_no).
    if (!current || !header) continue;
    const tokens = line.split(/\s+/);
    if (!Number.isFinite(Number(tokens[0]))) continue;

    const row = parseRow(tokens, header, iOfvIdx);
    if (row) current.rows.push(row);
  }

  if (current) tables.push(current);
  return tables;
}

/** Convenience: return the last (i.e. final $EST step) table, or null. */
export function lastPhiTable(text: string): PhiTable | null {
  const tables = parsePhi(text);
  return tables.length > 0 ? tables[tables.length - 1] : null;
}

function parseRow(tokens: string[], header: string[], iOfvIdx: number): PhiRow | null {
  // Column layout: [SUBJECT_NO, ID, PHI(1)…PHI(n), PHC(...), OBJ].
  // We need the ID, the PHI(...) values, and the iOFV. PHC columns are
  // skipped (not surfaced yet).
  const idIdx = header.findIndex((h) => /^ID$/i.test(h));
  if (idIdx < 0 || idIdx >= tokens.length) return null;

  const idToken = tokens[idIdx];
  const idNum = Number(idToken);
  const id: number | string = Number.isFinite(idNum) ? idNum : idToken;

  const etas: number[] = [];
  for (let i = 0; i < header.length && i < tokens.length; i++) {
    if (/^PHI\(\d+\)$/i.test(header[i])) {
      const v = Number(tokens[i]);
      if (Number.isFinite(v)) etas.push(v);
    }
  }

  let iOfv: number | null = null;
  if (iOfvIdx >= 0 && iOfvIdx < tokens.length) {
    const v = Number(tokens[iOfvIdx]);
    if (Number.isFinite(v)) iOfv = v;
  }

  return { id, etas, iOfv };
}
