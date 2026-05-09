// Shared NM7 `TABLE NO.` block helpers — used by parse-cor / parse-cnv
// / parse-phi (and any future per-`$EST` block parser). Each NM7 output
// file (.cor, .cnv, .phi, .ext) opens an estimation step with:
//
//   TABLE NO.     N: <method>: Problem=… Subproblem=… …
//
// followed by a header row and a body of marker / data rows. The two
// helpers here cover the always-the-same parts of that envelope.

/**
 * Extract the human-readable method label from a `TABLE NO. N: <label>:
 * Problem=…` line. Returns the trimmed label (e.g. `"First Order
 * Conditional Estimation with Interaction"`). Falls back to the whole
 * post-`:` substring when the trailing `: Problem=` is missing.
 */
export function extractTableMethod(line: string): string {
  const afterColon = line.replace(/^TABLE\s+NO\.\s*\d+\s*:\s*/i, '');
  const m = afterColon.match(/^(.*?):\s*Problem=/i);
  return (m ? m[1] : afterColon).trim();
}

/**
 * Locate the OFV column index in a parsed header row. NM7 names the
 * objective-function column `…OBJ` (e.g. `SAEMOBJ`, `IMPOBJ`, `OBJ`,
 * `BAYESOBJ`) and emits it as the last column in practice — but
 * scanning by name pattern is more robust than "always the last
 * column". Returns -1 when no `…OBJ` column is found.
 */
export function pickOfvColumn(header: readonly string[]): number {
  for (let i = header.length - 1; i >= 0; i--) {
    if (/OBJ$/i.test(header[i])) return i;
  }
  return -1;
}
