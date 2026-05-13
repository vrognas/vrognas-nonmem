// Shared low-level `.ext` parser. `parseExtFit` (final estimates) and
// `parseExtTrajectory` (per-iteration values) both walk the same file
// structure: a sequence of `TABLE NO. N: <method>` headers, each
// followed by an `ITERATION ...` column header and zero-or-more data
// rows. The two callers consume different subsets (fit cares about
// the negative-sentinel rows; trajectory cares about non-negative
// iter rows), but the tokenisation and header-normalisation logic is
// identical.
//
// Lifted out as a shared module v0.0.192 to remove drift risk (one
// caller's THETA1→THETA(1) rewrite was a function called
// `rewriteHeader`, the other's was `normalizeName` — bit-for-bit
// identical bodies). The TABLE-block envelope itself was lifted into
// `parse-table-blocks.ts` later — see that file's header for the
// shared shape across `.ext`/`.phi`/`.cor`/`.cnv`.

import { parseTableBlocks } from './parse-table-blocks';

/**
 * One data row inside an `.ext` TABLE block. `iter` is the leading
 * iteration column (negative sentinels for finals / SEs / etc.,
 * non-negative for live trajectory iterations). `tokens` is the rest
 * of the row — `header.length` numeric strings, one per column.
 */
export interface ExtBlockRow {
  iter: number;
  /** Raw numeric tokens (strings), excluding the leading iter column. */
  tokens: string[];
}

/**
 * One `TABLE NO.` block. NM emits one per `$EST` step in a chained
 * estimation.
 */
export interface ExtBlock {
  /** Method label parsed from the `TABLE NO.` header line. */
  method: string;
  /**
   * Column names, leading `ITERATION` token stripped + normalised
   * (`THETA1` → `THETA(1)`). When the block had no `ITERATION` line
   * (truncated file), this is `null` and the consumer must skip the
   * block.
   */
  header: string[] | null;
  /** All data rows in source order. */
  rows: ExtBlockRow[];
}

/**
 * Parse a `.ext` file into TABLE blocks. Returns one entry per
 * `TABLE NO.` header in order. Blocks without an `ITERATION` line are
 * still returned with `header: null` so the caller can detect
 * truncation explicitly. Non-numeric leading tokens (NM's negative
 * sentinels are fine — they're finite numbers) are dropped at the row
 * level.
 */
export function parseExtBlocks(text: string): ExtBlock[] {
  return parseTableBlocks(text, (l) => /^ITERATION\b/i.test(l)).map((b) => {
    const header = b.headerTokens ? b.headerTokens.slice(1).map(normalizeColumnName) : null;
    const rows: ExtBlockRow[] = [];
    for (const line of b.rowLines) {
      const tokens = line.split(/\s+/);
      const iter = Number(tokens[0]);
      if (!Number.isFinite(iter)) continue;
      rows.push({ iter, tokens: tokens.slice(1) });
    }
    return { method: b.method, header, rows };
  });
}

/**
 * Single source of truth for `.ext` column-name normalisation.
 * NONMEM writes `THETA1` (no parens) but the rest of the codebase
 * uses access-key form `THETA(1)` (parens-with-index, matching how
 * vscode-nmtran and the inspector key parameters). `OMEGA(1,1)` and
 * `SIGMA(1,1)` pass through unchanged. `OBJ` passes through (the
 * caller extracts it separately).
 */
export function normalizeColumnName(token: string): string {
  const m = token.match(/^THETA(\d+)$/i);
  return m ? `THETA(${m[1]})` : token;
}
