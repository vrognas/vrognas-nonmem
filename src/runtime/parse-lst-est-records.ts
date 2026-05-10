// Extract verbatim `$ESTIMATION` records from the `.lst`'s embedded
// control-stream echo. Per-record tokens are the **literal user
// intent** — distinct from the XML's `<nm:estimation_options>` which
// carries the runtime-resolved attribute set after NONMEM has applied
// its sentinel translations, AUTO=N expansions, and propagation rules.
//
// Why this is load-bearing for the Fit Inspector:
//
//   - NOABORT vs NOHABORT — XML conflates both into `abort='no'`.
//     Empirically verified (NM 7.6.0). The user's literal text is
//     the only signal that survives.
//   - PRINT, POSTHOC, AUTO, CENTERING, ETABARCHECK, NOSORT — never
//     emitted in XML even when set. Empirically verified.
//   - Propagation disambiguation — for step N of a chain, knowing
//     which tokens the user wrote on THIS step lets us distinguish
//     "explicit on step N" from "propagated from step N-1" / "set by
//     AUTO=N". The XML flattens this distinction.
//
// NMTRAN record syntax: a `$RECORD` line plus all subsequent lines
// (continuation) until the next `$` record. Tokens are whitespace- or
// comma-separated. `;` introduces an end-of-line comment.

/**
 * One `$EST`-style record's worth of user-typed options.
 */
export interface RawEstRecord {
  /**
   * The record-introducing keyword as the user wrote it: `$EST`,
   * `$ESTIMATION`, `$ESTIMATE`, or `$ESTM`. Case-preserved.
   */
  keyword: string;
  /**
   * Verbatim text after the keyword, with continuation lines joined
   * by single spaces and `;` comments stripped. Whitespace-collapsed
   * for downstream stability.
   */
  rawText: string;
  /**
   * Tokens — either flags (`POSTHOC`, `NOABORT`) or `KEY=VALUE`
   * (`METHOD=COND`, `PRINT=10`). User's order preserved.
   */
  tokens: string[];
  /** Zero-based index in the chained-EST order. */
  index: number;
}

const EST_KEYWORD_RE = /^\s*\$(ESTIMATION|ESTIMATE|ESTM|EST)\b/i;
const RECORD_BOUNDARY_RE = /^\s*\$[A-Za-z]+/;

/**
 * Extract all `$EST` records from an NMTRAN control-stream slice (the
 * output of `extractControlStream`). Returns `[]` when the stream has
 * no `$EST` records, e.g. mod-mode rendering or runs aborted before
 * estimation.
 */
export function parseLstEstRecords(controlStream: string): RawEstRecord[] {
  const lines = controlStream.split(/\r?\n/);
  const records: RawEstRecord[] = [];
  let inRecord = false;
  let currentLines: string[] = [];
  let currentKeyword = '';

  const flush = () => {
    if (!inRecord) return;
    const joined = currentLines.join(' ').replace(/\s+/g, ' ').trim();
    records.push({
      keyword: currentKeyword,
      rawText: joined,
      tokens: tokenize(joined),
      index: records.length,
    });
    inRecord = false;
    currentLines = [];
    currentKeyword = '';
  };

  for (const line of lines) {
    const estMatch = line.match(EST_KEYWORD_RE);
    if (estMatch) {
      flush(); // close previous record (if any)
      inRecord = true;
      currentKeyword = '$' + estMatch[1].toUpperCase();
      // Body of the line excluding the keyword (and the leading `$`).
      // `match.index` is start of whitespace; offset to the keyword's end.
      const afterKeyword = line.slice(line.toLowerCase().indexOf(estMatch[1].toLowerCase()) + estMatch[1].length);
      currentLines.push(stripComment(afterKeyword));
    } else if (RECORD_BOUNDARY_RE.test(line)) {
      // Hit a different `$RECORD` — close current $EST if any.
      flush();
    } else if (inRecord) {
      // Continuation line within the current $EST record.
      currentLines.push(stripComment(line));
    }
  }
  flush();
  return records;
}

/**
 * Split a $EST body into tokens. NMTRAN allows whitespace OR commas as
 * separators; a `KEY=VALUE` token can have spaces around the `=` sign
 * which we preserve back to the canonical compact form.
 */
function tokenize(text: string): string[] {
  // Normalise `KEY = VALUE` and `KEY =VALUE` and `KEY= VALUE` → `KEY=VALUE`.
  // Pre-pass: collapse spaces around `=` so the split produces clean tokens.
  const compact = text.replace(/\s*=\s*/g, '=');
  // Split on whitespace OR commas. Filter empties from runs of separators.
  return compact
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Strip an end-of-line `;` comment. Returns the line as-is if no `;`
 * is present. NMTRAN doesn't have block comments, so per-line is
 * sufficient.
 */
function stripComment(line: string): string {
  const semicolon = line.indexOf(';');
  return semicolon === -1 ? line : line.slice(0, semicolon);
}
