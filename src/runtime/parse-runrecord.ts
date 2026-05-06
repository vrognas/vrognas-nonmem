// Parse / write PsN's `runrecord` `;;` comment block under $PROBLEM.
//
// Spec: `runrecord_userguide.pdf` v5.3.1. Block starts with the
// `$PROBLEM` (or `$PROB`) line; its body is a contiguous run of `;;`
// comments immediately below. Each tag is `;; (<N>.)? <TagName>: <body>`
// where `<N>.` is an optional cosmetic number prefix and `<body>` is
// either inline (Based on:) or spans subsequent `;;` continuation
// lines until the next tag.
//
// Only `Based on:` is special-cased here — it's the parent-linkage
// pointer M11 cares about and the only tag with an inline value.
// Other tags pass through to a generic `tags` map; M11-B/M11-C can
// surface them in the lineage view without changes here.

const PROB_RE = /^\s*\$PROB(LEM)?\b/i;
const RECORD_RE = /^\s*\$\w+/;
// `;; (<N>.)? <TagName>: <inline-body>`.
// TagName must start with an uppercase letter and contain only letters
// + spaces (≤ 30 chars). This rejects continuation lines whose body
// happens to contain `<word>:<word>` (e.g. `;; uses ITS:FOCE first`)
// — without the constraint they were misinterpreted as a new tag,
// shadowing the parent tag's continuation.
const TAG_LINE_RE = /^(?:\d+\.\s*)?([A-Z][A-Za-z ]{0,30}):\s*(.*)$/;
const BASED_ON_VALUE_RE = /^(\d+)\s*(\[nodOFV\])?\s*$/;

export interface RunrecordTags {
  /** Parent run number from `;; Based on: N`; null when absent or unparseable. */
  basedOn: number | null;
  /** False when `;; Based on: N [nodOFV]` was set — parent exists but ΔOFV is not meaningful. */
  computeDeltaOfv: boolean;
  /**
   * All non-Based-on runrecord tags by canonical name → trimmed body.
   * Multi-line bodies join on `\n`. Empty-body tags map to `''`.
   */
  tags: Map<string, string>;
}

const EMPTY: RunrecordTags = { basedOn: null, computeDeltaOfv: true, tags: new Map() };

/**
 * Parse the runrecord block below the first `$PROBLEM` (or `$PROB`)
 * record. Returns an EMPTY result when no such record exists.
 */
export function parseRunrecord(modText: string): RunrecordTags {
  const lines = modText.split(/\r?\n/);
  const probIdx = lines.findIndex((l) => PROB_RE.test(l));
  if (probIdx === -1) return { ...EMPTY, tags: new Map() };

  const tags = new Map<string, string>();
  let currentTag: string | null = null;
  let currentBody: string[] = [];
  const flush = (): void => {
    if (currentTag === null) return;
    const body = currentBody.join('\n').trim();
    const existing = tags.get(currentTag);
    tags.set(currentTag, existing === undefined ? body : `${existing}\n${body}`);
    currentTag = null;
    currentBody = [];
  };

  for (let i = probIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '') continue; // blank lines allowed between tags
    if (RECORD_RE.test(trimmed)) break; // next $RECORD ends the block
    if (!trimmed.startsWith(';;')) break; // single-`;` comment or code ends the block
    const body = trimmed.replace(/^;;\s*/, '');
    const tagMatch = body.match(TAG_LINE_RE);
    if (tagMatch) {
      flush();
      currentTag = tagMatch[1].trim();
      currentBody = tagMatch[2] ? [tagMatch[2]] : [];
    } else if (currentTag !== null) {
      // Continuation line for the active tag.
      currentBody.push(body);
    }
    // else: orphan `;;` line before any tag — drop silently.
  }
  flush();

  // Lift `Based on` out of the generic map; it has special semantics
  // (number + [nodOFV] modifier) the caller uses directly.
  const basedOnRaw = tags.get('Based on');
  let basedOn: number | null = null;
  let computeDeltaOfv = true;
  if (basedOnRaw !== undefined) {
    const m = basedOnRaw.match(BASED_ON_VALUE_RE);
    if (m) {
      basedOn = Number(m[1]);
      computeDeltaOfv = !m[2];
    }
  }
  tags.delete('Based on');

  return { basedOn, computeDeltaOfv, tags };
}

/**
 * Write/replace `;; Based on: N` directly below the first `$PROBLEM`
 * (or `$PROB`). Idempotent: an existing `;; Based on:` (with or
 * without the optional `;; <N>. ` prefix) is replaced rather than
 * duplicated. Returns the original text unchanged when there is no
 * `$PROB` record (defensive — promoteEstimates always produces one,
 * but better to no-op than corrupt).
 *
 * The `[nodOFV]` modifier on an existing line is **preserved** when
 * the parent number stays the same (idempotent re-promote case). If
 * the parent number changes the modifier is dropped — it described
 * the (this-run, OLD-parent) pair and doesn't apply to the new pair.
 */
export function setBasedOn(modText: string, parentRunNumber: number): string {
  const lines = modText.split(/\r?\n/);
  const probIdx = lines.findIndex((l) => PROB_RE.test(l));
  if (probIdx === -1) return modText;

  // Walk the block below $PROB looking for an existing Based-on line.
  for (let i = probIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '') continue;
    if (RECORD_RE.test(trimmed)) break;
    if (!trimmed.startsWith(';;')) break;
    const body = trimmed.replace(/^;;\s*/, '');
    const tagMatch = body.match(TAG_LINE_RE);
    if (tagMatch && tagMatch[1].trim() === 'Based on') {
      const existing = tagMatch[2].match(BASED_ON_VALUE_RE);
      const sameParent = existing !== null && Number(existing[1]) === parentRunNumber;
      const preserveNodOfv = sameParent && Boolean(existing?.[2]);
      lines[i] = preserveNodOfv
        ? `;; Based on: ${parentRunNumber} [nodOFV]`
        : `;; Based on: ${parentRunNumber}`;
      return joinPreservingTrailingNewline(lines, modText);
    }
  }
  // No existing marker — insert directly after $PROB.
  lines.splice(probIdx + 1, 0, `;; Based on: ${parentRunNumber}`);
  return joinPreservingTrailingNewline(lines, modText);
}

/**
 * Re-join split-then-edited lines with the dominant line separator of
 * the original file. NMTRAN models edited on Windows / Pirana are
 * commonly CRLF; without separator preservation, every promote-write
 * would silently rewrite the file's line endings, producing a Git
 * diff that touches every line.
 */
function joinPreservingTrailingNewline(lines: string[], original: string): string {
  const crlfCount = (original.match(/\r\n/g) ?? []).length;
  const totalLf = (original.match(/\n/g) ?? []).length;
  const sep = crlfCount > totalLf - crlfCount ? '\r\n' : '\n';
  const joined = lines.join(sep);
  return original.endsWith('\n') && !joined.endsWith(sep) ? joined + sep : joined;
}
