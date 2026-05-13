// Shared NM7 TABLE-block iterator — extracts the common envelope
// shared by `.ext`, `.phi`, `.cor`, and `.cnv` files. Each one is a
// sequence of `TABLE NO. N: <method>` headers, each block carrying a
// single column-header line followed by data rows, terminated by the
// next TABLE NO. or EOF.
//
// Variable bits left to the caller:
//   - The column-header predicate (`ITERATION` / `SUBJECT_NO` / `NAME`)
//   - Header post-processing (strip leading token? compute special col
//     indices? normalise names?)
//   - Row interpretation (numeric iter + tokens / marker-row switch /
//     row-named lookup / etc.)
//
// The iterator returns one `TableBlock` per `TABLE NO.` header in source
// order. Blocks with no header line (truncated file) are still returned
// so the caller can detect truncation; `headerTokens` is null in that
// case. Only the FIRST line matching `isHeader` within a block is taken
// as the header — subsequent matches fall through to `rowLines`. This
// matches `parse-cnv`'s documented behaviour (a stray `ITERATION`
// re-occurrence inside the block is just another data line).

import { extractTableMethod } from './parse-table-header';

export interface TableBlock {
  /** Method label parsed from the `TABLE NO. N: <method>` line. */
  method: string;
  /**
   * Whitespace-split tokens from the first line matching `isHeader`
   * inside this block. `null` when no such line was found (truncated
   * block or wrong predicate). Tokens are returned in raw form — the
   * caller decides whether to strip a leading sentinel (`ITERATION` /
   * `NAME`) or normalise column names.
   */
  headerTokens: string[] | null;
  /**
   * All non-empty lines between the header and the next `TABLE NO.` /
   * EOF, in source order. Trimmed; not yet tokenised. Caller splits as
   * needed (some parsers want all tokens, others want the leading
   * marker only).
   */
  rowLines: string[];
}

/**
 * Parse NONMEM output text into TABLE blocks. `isHeader` identifies the
 * column-header line within each block. Returns `[]` when no TABLE
 * header appears (caller treats as "no parseable content" — same
 * contract as `parsePhi` / `parseCor` / `parseCnv` had before this
 * extraction).
 */
export function parseTableBlocks(
  text: string,
  isHeader: (line: string) => boolean,
): TableBlock[] {
  const blocks: TableBlock[] = [];
  let current: TableBlock | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^TABLE\s+NO\b/i.test(line)) {
      if (current) blocks.push(current);
      current = {
        method: extractTableMethod(line),
        headerTokens: null,
        rowLines: [],
      };
      continue;
    }

    if (!current) continue;

    // First header-matching line is THE header; later matches fall
    // through as row data (covers parse-cnv's stray-ITERATION guard).
    if (current.headerTokens === null && isHeader(line)) {
      current.headerTokens = line.split(/\s+/);
      continue;
    }

    current.rowLines.push(line);
  }

  if (current) blocks.push(current);
  return blocks;
}
