import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeEdgeIOfvSummary, loadEdgeIOfvSummary } from '../../src/views/lineage-edge-iofv';
import type { PhiTable } from '../../src/runtime/parse-phi';

// Minimal valid .phi text used by the fs-shell tests below.
function phiText(
  rows: Array<[number, number]>,
  method = 'First Order Conditional Estimation',
): string {
  const header =
    `TABLE NO.     1: ${method}: Problem=1\n` +
    ` SUBJECT_NO   ID           PHI(1)       PHC(1,1)     OBJ\n`;
  const body = rows
    .map(
      ([id, ofv], idx) =>
        `   ${String(idx + 1).padStart(7)}  ${String(id).padStart(7)}` +
        `   1.00000E-01   1.00000E-03  ${ofv.toFixed(4)}\n`,
    )
    .join('');
  return header + body;
}

// Helper: build a minimal PhiTable with paired (id, iOfv) tuples.
// ETAs / method label aren't read by computeEdgeIOfvSummary; pass empty.
function tbl(rows: Array<[number | string, number]>): PhiTable {
  return {
    method: 'TEST',
    rows: rows.map(([id, iOfv]) => ({ id, etas: [], iOfv })),
  };
}

describe('computeEdgeIOfvSummary', () => {
  it('happy path: all subjects within indifference zone (|Δ| < threshold)', () => {
    // 5 subjects, each iOFV moves by < 3.84 between parent and child.
    const parent = tbl([
      [1, 100.0],
      [2, 200.0],
      [3, 150.0],
      [4, 175.0],
      [5, 125.0],
    ]);
    const child = tbl([
      [1, 99.0],
      [2, 198.0],
      [3, 152.0],
      [4, 174.0],
      [5, 124.0],
    ]);
    const s = computeEdgeIOfvSummary(parent, child, 3.84);
    expect(s).not.toBeNull();
    expect(s!.n).toBe(5);
    expect(s!.nImproved).toBe(0);
    expect(s!.nWorsened).toBe(0);
    expect(s!.nIndifferent).toBe(5);
    // Total Δ = -1 + -2 + 2 + -1 + -1 = -3 (small net improvement, but not significant per subject).
    expect(s!.totalDelta).toBeCloseTo(-3.0, 6);
    expect(s!.topImproved).toHaveLength(0);
    expect(s!.topWorsened).toHaveLength(0);
  });

  it('mixed: classifies improved/worsened/indifferent and sorts top-K by |Δ|', () => {
    // 6 subjects; 2 strongly improve, 2 strongly worsen, 2 indifferent.
    const parent = tbl([
      [1, 100.0],
      [2, 200.0],
      [3, 150.0],
      [4, 175.0],
      [5, 125.0],
      [6, 90.0],
    ]);
    const child = tbl([
      [1, 90.0], //  Δ -10  (improved, 10 ≥ 3.84)
      [2, 195.0], //  Δ  -5   (improved)
      [3, 160.0], //  Δ +10  (worsened)
      [4, 180.0], //  Δ  +5   (worsened)
      [5, 124.0], //  Δ  -1   (indifferent)
      [6, 91.5], //  Δ  +1.5 (indifferent)
    ]);
    const s = computeEdgeIOfvSummary(parent, child, 3.84);
    expect(s).not.toBeNull();
    expect(s!.n).toBe(6);
    expect(s!.nImproved).toBe(2);
    expect(s!.nWorsened).toBe(2);
    expect(s!.nIndifferent).toBe(2);
    expect(s!.totalDelta).toBeCloseTo(-10 - 5 + 10 + 5 - 1 + 1.5, 6);

    // topImproved: largest negative ΔiOFV first (subject 1: -10, then 2: -5).
    expect(s!.topImproved.map((r) => r.id)).toEqual([1, 2]);
    expect(s!.topImproved[0].deltaIOfv).toBeCloseTo(-10.0, 6);

    // topWorsened: largest positive ΔiOFV first (subject 3: +10, then 4: +5).
    expect(s!.topWorsened.map((r) => r.id)).toEqual([3, 4]);
    expect(s!.topWorsened[0].deltaIOfv).toBeCloseTo(10.0, 6);
  });

  it('inner-join on ID; null returned when either phi missing', () => {
    // Parent has subjects 1-5, child has 2-6. Intersection: 2,3,4,5.
    const parent = tbl([
      [1, 100.0],
      [2, 200.0],
      [3, 150.0],
      [4, 175.0],
      [5, 125.0],
    ]);
    const child = tbl([
      [2, 195.0],
      [3, 160.0],
      [4, 180.0],
      [5, 124.0],
      [6, 90.0],
    ]);
    const s = computeEdgeIOfvSummary(parent, child, 3.84);
    expect(s).not.toBeNull();
    expect(s!.n).toBe(4); // intersection only
    expect(s!.nImproved + s!.nWorsened + s!.nIndifferent).toBe(4);

    // Either side null → null result.
    expect(computeEdgeIOfvSummary(null, child, 3.84)).toBeNull();
    expect(computeEdgeIOfvSummary(parent, null, 3.84)).toBeNull();

    // Empty intersection (disjoint IDs) → null too — no signal to show.
    const disjointChild = tbl([[99, 50.0]]);
    expect(computeEdgeIOfvSummary(parent, disjointChild, 3.84)).toBeNull();
  });
});

describe('loadEdgeIOfvSummary (fs shell)', () => {
  it('reads, parses, and computes summary across two real .phi files', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'phi-edge-'));
    try {
      const parentPath = path.join(tmp, 'parent.phi');
      const childPath = path.join(tmp, 'child.phi');
      await fs.writeFile(
        parentPath,
        phiText([
          [1, 100],
          [2, 200],
          [3, 150],
        ]),
      );
      await fs.writeFile(
        childPath,
        phiText([
          [1, 90], //  Δ -10  (improved)
          [2, 198], //  Δ  -2  (indifferent)
          [3, 160], //  Δ +10  (worsened)
        ]),
      );
      const r = await loadEdgeIOfvSummary(parentPath, childPath, 3.84);
      expect(r.incomparableReason).toBeNull();
      expect(r.warning).toBeNull();
      expect(r.summary).not.toBeNull();
      const s = r.summary!;
      expect(s.n).toBe(3);
      expect(s.nImproved).toBe(1);
      expect(s.nWorsened).toBe(1);
      expect(s.nIndifferent).toBe(1);
      expect(s.totalDelta).toBeCloseTo(-2, 6);
      expect(s.topImproved[0].id).toBe(1);
      expect(s.topWorsened[0].id).toBe(3);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('returns all-null result when either path is null or file is missing', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'phi-edge-'));
    try {
      const realPath = path.join(tmp, 'real.phi');
      await fs.writeFile(realPath, phiText([[1, 100]]));
      const expectEmpty = (r: {
        summary: unknown;
        incomparableReason: unknown;
        warning: unknown;
      }) => {
        expect(r.summary).toBeNull();
        expect(r.incomparableReason).toBeNull();
        expect(r.warning).toBeNull();
      };
      expectEmpty(await loadEdgeIOfvSummary(null, realPath, 3.84));
      expectEmpty(await loadEdgeIOfvSummary(realPath, null, 3.84));
      const missing = path.join(tmp, 'missing.phi');
      expectEmpty(await loadEdgeIOfvSummary(missing, realPath, 3.84));
      expectEmpty(await loadEdgeIOfvSummary(realPath, missing, 3.84));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('refuses comparison when either side is a $DESIGN / D-OPTIMALITY run', async () => {
    // Empirical: run001 (FOCEI) → run008 ($DESIGN) was showing
    // `Σ ΔiOFV = +25` against `Total ΔOFV (.ext) = -39.61` because the
    // OBJ column for $DESIGN is per-subject FIM contribution, NOT iOFV.
    // The fix is to refuse the comparison and surface a reason instead.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'phi-edge-'));
    try {
      const parentPath = path.join(tmp, 'parent.phi');
      const childPath = path.join(tmp, 'child.phi');
      // Mirror real run001 / run008 method labels NONMEM emits.
      await fs.writeFile(
        parentPath,
        phiText(
          [
            [1, 1.5],
            [2, 3.2],
            [3, 6.2],
          ],
          'First Order Conditional Estimation with Interaction',
        ),
      );
      await fs.writeFile(
        childPath,
        phiText(
          [
            [1, 13.08],
            [2, 13.08],
            [3, 13.08],
          ],
          'First Order (Evaluation): D-OPTIMALITY',
        ),
      );
      const r = await loadEdgeIOfvSummary(parentPath, childPath, 3.84);
      expect(r.summary).toBeNull();
      expect(r.warning).toBeNull();
      expect(r.incomparableReason).toMatch(/D-OPTIMALITY/);
      expect(r.incomparableReason).toMatch(/Child run/);

      // Also covers the parent-side branch (e.g. user inverts the link).
      const r2 = await loadEdgeIOfvSummary(childPath, parentPath, 3.84);
      expect(r2.summary).toBeNull();
      expect(r2.warning).toBeNull();
      expect(r2.incomparableReason).toMatch(/Parent run/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('warns (but still computes) when methods differ between parent and child', async () => {
    // Different estimation methods (FOCEI → IMP). Per-subject Δ is
    // numerically defined but the additive constants don't cancel —
    // Σ ΔiOFV ≠ total ΔOFV. User-flagged: even IMP vs FOCEI should warn.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'phi-edge-'));
    try {
      const parentPath = path.join(tmp, 'parent.phi');
      const childPath = path.join(tmp, 'child.phi');
      await fs.writeFile(
        parentPath,
        phiText(
          [
            [1, 100],
            [2, 200],
          ],
          'First Order Conditional Estimation with Interaction',
        ),
      );
      await fs.writeFile(
        childPath,
        phiText(
          [
            [1, 90],
            [2, 195],
          ],
          'Importance Sampling',
        ),
      );
      const r = await loadEdgeIOfvSummary(parentPath, childPath, 3.84);
      expect(r.incomparableReason).toBeNull();
      // Summary is still computed — soft warning, not refusal.
      expect(r.summary).not.toBeNull();
      expect(r.summary!.n).toBe(2);
      expect(r.warning).toMatch(/Different estimation methods/i);
      expect(r.warning).toMatch(/First Order Conditional Estimation with Interaction/);
      expect(r.warning).toMatch(/Importance Sampling/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('does NOT warn when only the (Evaluation) suffix differs', async () => {
    // FOCEI converged vs FOCEI MAXEVAL=0: same likelihood function,
    // different parameter values. Per-subject diff IS comparable.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'phi-edge-'));
    try {
      const parentPath = path.join(tmp, 'parent.phi');
      const childPath = path.join(tmp, 'child.phi');
      await fs.writeFile(
        parentPath,
        phiText([[1, 100]], 'First Order Conditional Estimation with Interaction'),
      );
      await fs.writeFile(
        childPath,
        phiText(
          [[1, 95]],
          'First Order Conditional Estimation with Interaction (Evaluation)',
        ),
      );
      const r = await loadEdgeIOfvSummary(parentPath, childPath, 3.84);
      expect(r.incomparableReason).toBeNull();
      expect(r.warning).toBeNull();
      expect(r.summary).not.toBeNull();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
