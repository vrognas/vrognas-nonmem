// Count the number of `$ESTIMATION` / `$EST` records in NM-TRAN
// control-stream text. Used by the signal-send UX: when sending
// `stop.sig` to a model with multiple `$EST` records (e.g. the
// idiomatic SAEM -> IMP-EONLY refinement chain), we must warn the
// user that all subsequent steps will be skipped (empirically
// verified; see docs/empirical-notes.md S2 probe).
//
// Comment-aware: `;` starts a line comment and we strip it before
// matching. Both abbreviations (`$EST`, `$ESTI`, `$ESTIMATION`) are
// accepted — NM-TRAN normalises any prefix matching the keyword.

const REC_RE = /^\s*\$EST(?:I(?:M(?:A(?:T(?:I(?:O(?:N)?)?)?)?)?)?)?\b/i;

/**
 * Count `$ESTIMATION` records in a model text. Returns 0 for empty
 * input or a model that has no $EST yet (mod-mode while user is
 * still drafting). Strips `;`-comments per line before matching so
 * a commented-out `;$EST IMP EONLY=1` doesn't inflate the count.
 */
export function countEstimationRecords(modelText: string): number {
  let n = 0;
  for (const rawLine of modelText.split(/\r?\n/)) {
    const codeOnly = rawLine.split(';')[0];
    if (REC_RE.test(codeOnly)) n++;
  }
  return n;
}
