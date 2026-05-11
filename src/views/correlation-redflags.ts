// Correlation red-flag scan for the Fit Inspector. Surfaces parameter
// pairs whose absolute correlation exceeds a user-configurable
// threshold (default 0.95) — the textbook overparameterization signal.
//
// Pharmacometric framing the inspector also surfaces around this list:
// pairwise high |r| is ONE signal of overparameterization. The
// stronger evidence is the COMBINATION of (high pairwise |r|) +
// (high condition number) + (high RSE% on the involved parameters).
// The inspector renders the trio together so the user reads them as a
// joint diagnostic rather than as a single isolated number.
//
// Pure module — no fs, no vscode imports. The fs shell that loads the
// `.cor` file is not needed: we already pipe the parsed `CorTable` in
// through the inspector's existing load orchestration (mirrors how
// `.ext` and `.phi` are handled).

import type { CorTable } from '../runtime/parse-cor';

/**
 * One flagged parameter pair. `r` keeps its signed value (the user
 * cares about both strong positive and strong negative correlations
 * equally — both indicate near-redundancy). `kind` carries the colour
 * tier so the renderer doesn't reapply the threshold logic. Sort order
 * is by `|r|` descending across the returned list.
 */
export interface CorrelationRedFlag {
  a: string;
  b: string;
  r: number;
  /**
   * Colour tier matching the inspector's wider warn/bad vocabulary:
   *   - `'bad'`  when `|r| ≥ redThreshold` (red, default ≥ 0.95)
   *   - `'warn'` when `|r| ≥ warnThreshold` but below `redThreshold`
   *     (yellow, default ≥ 0.90 and < 0.95)
   */
  kind: 'warn' | 'bad';
}

/**
 * Scan a `CorTable` for parameter pairs with `|r| ≥ warnThreshold`.
 * Walks the upper triangle only (so each symmetric pair is returned
 * exactly once) and skips the diagonal (NM 7.2+ stores SE there, not
 * 1.0 — diagonal value isn't a "correlation" signal under either
 * convention).
 *
 * Returns an empty array when:
 *   - table is null (`.cor` missing / not parsed)
 *   - matrix is all-zero ($COV failed/skipped — NONMEM emits the matrix
 *     shape but fills with zero sentinels, same convention as `.ext`)
 *   - no pair meets the warn threshold
 *
 * Thresholds are clamped to `≥ 0` defensively. When `redThreshold ≤
 * warnThreshold` (caller misconfigured), every flagged pair classifies
 * as `'bad'` — degrades to single-tier behaviour rather than silently
 * dropping pairs.
 */
export function findCorrelationRedFlags(
  table: CorTable | null,
  warnThreshold: number,
  redThreshold: number,
): CorrelationRedFlag[] {
  if (!table) return [];
  const warn = Math.max(0, warnThreshold);
  const bad = Math.max(0, redThreshold);
  // Entry gate is the LOWER of the two thresholds. Otherwise misconfigured
  // input (bad < warn) silently drops the [bad, warn) band — pairs that
  // should classify as 'bad' wouldn't be seen at all. With the gate at
  // min(warn,bad), the comment's "degrades to single-tier" promise holds.
  const gate = Math.min(warn, bad);
  const flags: CorrelationRedFlag[] = [];
  const names = table.paramNames;
  for (let i = 0; i < names.length; i++) {
    const inner = table.values.get(names[i]);
    if (!inner) continue;
    for (let j = i + 1; j < names.length; j++) {
      const r = inner.get(names[j]);
      if (typeof r !== 'number' || !Number.isFinite(r)) continue;
      const abs = Math.abs(r);
      if (abs < gate) continue;
      const kind: 'warn' | 'bad' = abs >= bad ? 'bad' : 'warn';
      flags.push({ a: names[i], b: names[j], r, kind });
    }
  }
  flags.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
  return flags;
}
