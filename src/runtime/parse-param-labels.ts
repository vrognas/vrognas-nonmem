// Extract Pirana-style `; <label>` comments for `$THETA` / `$OMEGA` /
// `$SIGMA` parameter declarations from an NM-TRAN control stream.
//
// History: the symptoms that prompted this module — `$OMEGA BLOCK(N)`
// labels empty, `$THETA` labels off-by-one — turned out to be a
// cache-collision bug in vscode-nmtran's `ParameterScanner.scanDocument`
// when called via the `nmtran/parseModelText` LSP path used by lst-mode
// (synthetic `embedded://lst` URI + version=1 → first parse's result
// served for every subsequent embedded call). Fixed upstream in
// vscode-nmtran 0.4.22. We keep this module as defense-in-depth: any
// future regression in vscode-nmtran's comment field is insulated, and
// the override costs nothing when vscode-nmtran returns correct
// labels (we fall back to `t.comment` per-key when our map doesn't
// have an entry).
//
// Output shape: per-kind `Map<1-based-index, label>`. For OMEGA / SIGMA
// the index is the diagonal index — BLOCK rows attach their `; <label>`
// to the diagonal element on that row (`(K, K)` for the K-th row of
// the block); off-diagonal elements have no label. For THETA the index
// is the parameter index (`THETA(I)`).
//
// Multi-record support: a problem may contain multiple `$OMEGA` records
// (e.g. one BLOCK plus a diagonal-form one for additional variances).
// Indices count globally across records of the same kind; the counter
// is preserved across records and only reset at record-kind boundaries
// (a `$SIGMA` followed by `$OMEGA` would be a hard NMTRAN error anyway,
// so we don't worry about it).

export interface ParameterLabels {
  /** `THETA(I)` index (1-based) → label. */
  thetas: Map<number, string>;
  /** `OMEGA(I, I)` diagonal index (1-based) → label. */
  omegas: Map<number, string>;
  /** `SIGMA(I, I)` diagonal index (1-based) → label. */
  sigmas: Map<number, string>;
}

type Kind = 'theta' | 'omega' | 'sigma';

const RECORD_RE = /^\s*\$([A-Za-z]+)/;
const THETA_KW = /^THE(TA)?$/i;
const OMEGA_KW = /^OME(GA)?$/i;
const SIGMA_KW = /^SIG(MA)?$/i;
const NUMERIC_RE = /(?:^|\s)\(?[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/g;
const BLOCK_RE = /\bBLOCK\b/i;

/**
 * Walk the control stream and emit one `{theta|omega|sigma}` map per
 * kind. Pure / vscode-free / no IO — single string in, three Maps out.
 */
export function extractParameterLabels(controlStream: string): ParameterLabels {
  const out: ParameterLabels = {
    thetas: new Map(),
    omegas: new Map(),
    sigmas: new Map(),
  };
  // Global per-kind counters — preserved across multiple records of the
  // same kind. Reset only when first encountering the kind.
  const counters: Record<Kind, number> = { theta: 0, omega: 0, sigma: 0 };
  // Per-record BLOCK flag — line counts differently for BLOCK vs
  // diagonal-form. Reset on every $OMEGA / $SIGMA record header.
  let mode: Kind | null = null;
  let blockMode = false;

  for (const rawLine of controlStream.split(/\r?\n/)) {
    const recordMatch = rawLine.match(RECORD_RE);
    if (recordMatch) {
      const kw = recordMatch[1];
      const newKind = kindForKeyword(kw);
      mode = newKind;
      blockMode = newKind !== null && newKind !== 'theta' && BLOCK_RE.test(rawLine);
      // The record-header line itself can carry inline values for
      // OMEGA/SIGMA — e.g. `$OMEGA 0.1 ; A` (diagonal form on one line)
      // or `$OMEGA BLOCK(2) 0.1 0.05 0.1 ; M` (BLOCK on one line). Strip
      // the keyword + optional BLOCK(...) preamble and process the rest.
      const stripped = rawLine.replace(/^\s*\$\w+(?:\s+BLOCK\s*\([^)]*\))?/i, '');
      processBody(stripped, newKind, blockMode, counters, out);
      continue;
    }
    if (mode === null) continue;
    processBody(rawLine, mode, blockMode, counters, out);
  }
  return out;
}

function kindForKeyword(kw: string): Kind | null {
  if (THETA_KW.test(kw)) return 'theta';
  if (OMEGA_KW.test(kw)) return 'omega';
  if (SIGMA_KW.test(kw)) return 'sigma';
  return null;
}

/**
 * Advance the per-kind counter for the numeric tokens on `line` and,
 * when the line has a trailing `; <label>` comment, attach the label
 * to the appropriate index. For BLOCK matrices the label always
 * attaches to the LINE's diagonal index (which advances by 1 per row).
 * For diagonal-form / THETA the label attaches to the LAST value on
 * the line (so `$THETA 1 2 3 ; X` puts the label on THETA(3); the
 * Pirana convention.)
 */
function processBody(
  line: string,
  mode: Kind | null,
  blockMode: boolean,
  counters: Record<Kind, number>,
  out: ParameterLabels,
): void {
  if (mode === null) return;
  const semi = line.indexOf(';');
  const code = semi === -1 ? line : line.slice(0, semi);
  const comment = semi === -1 ? '' : line.slice(semi + 1).trim();
  // Count numeric tokens to know how to advance the counter. Tokens
  // come in forms like `0.1`, `-1.0e-3`, `1`, `(0, 1, 10)`-style
  // bounded init. For bounded form `(L, I, U)` we count 1 parameter
  // per parenthesised group; for now the naive numeric count is fine
  // for the common case (1 param per line) and degrades gracefully.
  const numericCount = (code.match(NUMERIC_RE) ?? []).length;
  if (numericCount === 0) return;

  if (blockMode && mode !== 'theta') {
    // BLOCK row: one DIAGONAL per row, regardless of how many values.
    counters[mode] += 1;
    if (comment) out[mapKey(mode)].set(counters[mode], comment);
    return;
  }
  // Diagonal-form / THETA: each numeric token is its own parameter.
  // Label attaches to the LAST one on the line.
  const lastIndex = counters[mode] + numericCount;
  counters[mode] = lastIndex;
  if (comment) out[mapKey(mode)].set(lastIndex, comment);
}

function mapKey(mode: Kind): 'thetas' | 'omegas' | 'sigmas' {
  return (mode + 's') as 'thetas' | 'omegas' | 'sigmas';
}
