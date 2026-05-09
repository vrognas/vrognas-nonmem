// Edge-level ΔiOFV summary — pairs two `.phi` tables (parent / child)
// and surfaces a per-subject difference distribution suitable for the
// lineage view's edge tooltip / drill-down.
//
// Why this exists. Total ΔOFV between two related runs is one number;
// it doesn't tell you *which* subjects benefit from the change. The
// linearized case-deletion-diagnostic literature (PsN `cdd`, the PAGE
// "Faster methods for case deletion diagnostics: dOFV and linearized
// dOFV" abstract) treats per-subject ΔiOFV with the same χ²₁ cut-off
// (default 3.84) we already use for total-ΔOFV edge colouring. Same
// threshold, same interpretation, just applied N times.
//
// `computeEdgeIOfvSummary` is pure (no fs, no vscode imports).
// `loadEdgeIOfvSummary` is the fs shell — reads + parses + computes.

import * as fs from 'node:fs/promises';
import { errMsg, NOOP_LOGGER, type Logger } from '../log-utils';
import { lastPhiTable, type PhiTable } from '../runtime/parse-phi';

/** Per-subject ΔiOFV row. `id` is whatever `.phi` reports — usually a
 *  number, but PsN-rewritten IDs can be strings, so we preserve. */
export interface EdgeIOfvRow {
  id: number | string;
  parentIOfv: number;
  childIOfv: number;
  /** child − parent. Negative = subject is better fit by the child run. */
  deltaIOfv: number;
}

/**
 * Result of attempting an edge-level ΔiOFV comparison. Four states:
 *   - `summary` non-null, `warning` null         → fully comparable
 *   - `summary` non-null, `warning` set          → SOFT warning: methods
 *     differ but the per-subject diff is still computed; caller should
 *     surface the warning above the tables (additive constants don't
 *     cancel — Σ ΔiOFV will diverge from total ΔOFV by the constant
 *     gap, which is itself informative)
 *   - `summary` null + `incomparableReason` set  → HARD refusal: at
 *     least one side is `$DESIGN` / D-OPTIMALITY; per-subject OBJ
 *     column is FIM contribution, not iOFV; the diff is meaningless.
 *     Caller should display the reason instead of any tables.
 *   - all null                                   → .phi missing /
 *     unparseable / disjoint subject IDs
 */
export interface IOfvLoadResult {
  summary: EdgeIOfvSummary | null;
  incomparableReason: string | null;
  warning: string | null;
}

/** Aggregate summary for the lineage edge between two runs. */
export interface EdgeIOfvSummary {
  /** Number of subjects with iOFV present on BOTH sides (inner-join cardinality). */
  n: number;
  /** Sum of per-subject Δ. Should approximate total ΔOFV on the edge
   *  (modulo non-additive constants per method). Useful as a sanity
   *  check against the edge's total ΔOFV from `.ext`. */
  totalDelta: number;
  /** Subjects whose ΔiOFV ≤ −threshold (significant improvement under LRT). */
  nImproved: number;
  /** Subjects whose ΔiOFV ≥ +threshold (significant worsening). */
  nWorsened: number;
  /** Subjects with |ΔiOFV| < threshold (within indifference zone). */
  nIndifferent: number;
  /** Top-K most-improved (most-negative Δ) subjects. Sorted by Δ ascending.
   *  Empty when nImproved = 0. */
  topImproved: EdgeIOfvRow[];
  /** Top-K most-worsened (most-positive Δ) subjects. Sorted by Δ descending.
   *  Empty when nWorsened = 0. */
  topWorsened: EdgeIOfvRow[];
}

const TOP_K = 10;

/**
 * Pair two `PhiTable`s on subject ID (inner-join), compute per-subject
 * ΔiOFV, and return aggregate counts + top-K outliers in both
 * directions. Returns null when:
 *   - either side is null (run aborted, .phi missing, or method
 *     doesn't emit one — e.g. NUTS with `$BAYES METHOD=NUTS` skips .phi)
 *   - the inner-join is empty (disjoint subject sets — e.g. dataset
 *     was changed between runs; not a meaningful comparison anyway)
 *
 * `threshold` defaults to 3.84 (χ²₁,0.05 LRT cutoff per Keizer 2013) —
 * the same default we use for total-ΔOFV edge colouring. Caller can
 * override via the `nonmem.lineageOfvThreshold` workspace setting at
 * the call site.
 *
 * Subjects whose iOfv is null on either side (.phi format quirk: some
 * methods omit OBJ for non-fitted iterations) are dropped from the
 * comparison silently — same conservative rule as `parseExtFit`'s
 * "drop all-zero SE row" treatment.
 */
export function computeEdgeIOfvSummary(
  parent: PhiTable | null,
  child: PhiTable | null,
  threshold: number,
): EdgeIOfvSummary | null {
  if (!parent || !child) return null;

  const parentByKey = new Map<string, number>();
  for (const r of parent.rows) {
    if (r.iOfv === null) continue;
    parentByKey.set(idKey(r.id), r.iOfv);
  }
  if (parentByKey.size === 0) return null;

  // Single-pass classify: build improved/worsened buckets while we
  // count + sum, instead of three full passes over `rows`. Hot path on
  // panel click; clinical datasets can hit 1000+ subjects.
  const improved: EdgeIOfvRow[] = [];
  const worsened: EdgeIOfvRow[] = [];
  let totalDelta = 0;
  let n = 0;
  let nIndifferent = 0;
  for (const r of child.rows) {
    if (r.iOfv === null) continue;
    const parentIOfv = parentByKey.get(idKey(r.id));
    if (parentIOfv === undefined) continue;
    const deltaIOfv = r.iOfv - parentIOfv;
    const row: EdgeIOfvRow = { id: r.id, parentIOfv, childIOfv: r.iOfv, deltaIOfv };
    n++;
    totalDelta += deltaIOfv;
    if (deltaIOfv <= -threshold) improved.push(row);
    else if (deltaIOfv >= threshold) worsened.push(row);
    else nIndifferent++;
  }
  if (n === 0) return null;

  // Most-negative first for improved; most-positive first for worsened.
  improved.sort((a, b) => a.deltaIOfv - b.deltaIOfv);
  worsened.sort((a, b) => b.deltaIOfv - a.deltaIOfv);

  return {
    n,
    totalDelta,
    nImproved: improved.length,
    nWorsened: worsened.length,
    nIndifferent,
    topImproved: improved.slice(0, TOP_K),
    topWorsened: worsened.slice(0, TOP_K),
  };
}

/**
 * Load both `.phi` files, parse the final-step table on each side, and
 * pass through `computeEdgeIOfvSummary` after a method-comparability
 * gate. Three result states (see `IOfvLoadResult` for the full triage):
 *   - `summary` non-null              → comparison succeeded
 *   - `incomparableReason` set        → at least one side is a $DESIGN /
 *     D-OPTIMALITY run; OBJ column is FIM contribution, not iOFV.
 *     Comparing it to a fit's iOFV is a category error.
 *   - both null                       → .phi missing on a side, file
 *     unparseable, or disjoint subject IDs.
 *
 * Read failures are logged via `log` but never thrown — callers fan out
 * via `Promise.all` and shouldn't have to per-call try/catch.
 */
export async function loadEdgeIOfvSummary(
  parentPhiPath: string | null,
  childPhiPath: string | null,
  threshold: number,
  log: Logger = NOOP_LOGGER,
): Promise<IOfvLoadResult> {
  if (!parentPhiPath || !childPhiPath) {
    return { summary: null, incomparableReason: null, warning: null };
  }
  const [parent, child] = await Promise.all([
    readPhiTable(parentPhiPath, log),
    readPhiTable(childPhiPath, log),
  ]);
  if (!parent || !child) {
    return { summary: null, incomparableReason: null, warning: null };
  }
  const { incomparableReason, warning } = checkComparability(parent, child);
  if (incomparableReason) {
    return { summary: null, incomparableReason, warning: null };
  }
  return {
    summary: computeEdgeIOfvSummary(parent, child, threshold),
    incomparableReason: null,
    warning,
  };
}

/**
 * Decide whether two `.phi` tables can be meaningfully diffed. Returns
 * an `incomparableReason` (HARD refusal) and/or a `warning` (SOFT
 * caveat — comparison still computed, but the user should be aware).
 *
 * HARD refusal:
 *   1. **D-OPTIMALITY** in the method label = `$DESIGN` problem. The
 *      OBJ column is per-subject Fisher Information Matrix contribution
 *      (a determinant-derived quantity), not a per-subject likelihood
 *      contribution. Total .ext OFV is the global D-opt criterion, not
 *      a fit OFV — comparing it to a parent fit's OFV is a category
 *      error. Empirical confirmation: run001 (FOCEI fit, OFV=15.24,
 *      iOFVs sum to 15.25) vs run008 ($DESIGN, criterion=−24.37,
 *      per-subject OBJ = 13.08 uniformly across all subjects → not
 *      iOFV). Without this gate the panel showed `Σ ΔiOFV = +25` while
 *      `Total ΔOFV (.ext) = −39.61` — visually impossible because the
 *      two sums measure different things.
 *
 * SOFT warning:
 *   2. **Method labels differ** between parent and child (e.g.
 *      FOCEI → IMP, FOCE → SAEM, FOCEI → Bayesian). Additive
 *      constants in the OFV decomposition (½log det Ω, ½log det Vᵢ
 *      from Eq.12–13 of the basic-theory doc) take different forms
 *      under different methods' approximations — Laplace expansion vs
 *      first-order linearisation vs Monte-Carlo IS estimate vs SAEM
 *      stochastic step, etc. The per-subject Δ is still numerically
 *      defined and a useful relative-influence signal, but Σ ΔiOFV
 *      will not equal total ΔOFV; the gap is the constant difference,
 *      which is itself informative for the modeler. The `(Evaluation)`
 *      suffix (MAXEVAL=0) is normalised away — same likelihood
 *      function, different parameter values, no warning needed.
 */
export function checkComparability(
  parent: PhiTable,
  child: PhiTable,
): { incomparableReason: string | null; warning: string | null } {
  if (/D-OPTIMALITY/i.test(child.method)) {
    return {
      incomparableReason:
        'Child run uses $DESIGN (D-OPTIMALITY). The .phi OBJ column is per-subject ' +
        'FIM contribution, not iOFV — not comparable to a fit run.',
      warning: null,
    };
  }
  if (/D-OPTIMALITY/i.test(parent.method)) {
    return {
      incomparableReason:
        'Parent run uses $DESIGN (D-OPTIMALITY). The .phi OBJ column is per-subject ' +
        'FIM contribution, not iOFV — not comparable to a fit run.',
      warning: null,
    };
  }
  if (normalizeMethod(parent.method) !== normalizeMethod(child.method)) {
    return {
      incomparableReason: null,
      warning:
        `Different estimation methods (${parent.method} → ${child.method}). ` +
        `Per-subject ΔiOFV is computed, but the methods' additive constants ` +
        `differ — Σ ΔiOFV will not equal total ΔOFV; the gap is informative ` +
        `but the absolute Δ values shouldn't be over-interpreted.`,
    };
  }
  return { incomparableReason: null, warning: null };
}

/**
 * Canonicalise a `.phi` method label for cross-run comparison: collapse
 * whitespace, strip the `(Evaluation)` MAXEVAL=0 suffix (orthogonal to
 * method type — same likelihood function, evaluated at init), and
 * lowercase. Direct text-equality on the result is the comparator.
 */
function normalizeMethod(m: string): string {
  return m
    .replace(/\s*\(\s*evaluation\s*\)\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function readPhiTable(phiPath: string, log: Logger): Promise<PhiTable | null> {
  try {
    const text = await fs.readFile(phiPath, 'utf8');
    return lastPhiTable(text);
  } catch (e) {
    log(`lineage-edge-iofv: read/parse failed for ${phiPath}: ${errMsg(e)}`);
    return null;
  }
}

/**
 * Normalise an ID for map-key use. PsN sometimes rewrites integer IDs
 * to strings ("1" vs 1) or pads with leading zeros across runs; we
 * coerce to canonical decimal-string form so a parent's `1` matches a
 * child's `"1"` / `"01"`. Non-numeric IDs pass through verbatim
 * (some datasets use string subject IDs — Pirana cohort fixtures, etc.).
 */
function idKey(id: number | string): string {
  if (typeof id === 'number') return Number.isFinite(id) ? String(id) : `__nan__${id}`;
  const n = Number(id);
  return Number.isFinite(n) ? String(n) : id;
}
