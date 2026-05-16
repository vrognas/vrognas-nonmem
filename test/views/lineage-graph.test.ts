import { describe, it, expect } from 'vitest';
import {
  buildLineageGraph,
  wouldOverrideCreateCycle,
  type LineageEdge,
  type LineageNodeInput,
} from '../../src/views/lineage-graph';

function input(
  runNumber: number,
  ofv: number | null,
  basedOn: number | null,
  computeDeltaOfv = true,
): LineageNodeInput {
  const padded = String(runNumber).padStart(3, '0');
  return {
    runNumber,
    modelPath: `/tmp/run${padded}.mod`,
    lstPath: `/tmp/run${padded}.lst`,
    phiPath: null,
    basename: `run${padded}`,
    description: null,
    label: null,
    ofv,
    termination: null,
    dataFile: null,
    basedOn,
    computeDeltaOfv,
  };
}

function pathOf(runNumber: number): string {
  return `/tmp/run${String(runNumber).padStart(3, '0')}.mod`;
}

describe('buildLineageGraph', () => {
  it('builds a 3-node chain (1→2→3) with Keizer-2013 edge colors', () => {
    const g = buildLineageGraph([input(1, 4612.4, null), input(2, 4598.7, 1), input(3, 4596.0, 2)]);

    expect(g.nodes.length).toBe(3);
    expect(g.edges.length).toBe(2);
    expect(g.roots).toEqual([pathOf(1)]);

    const e12 = g.edges.find((e) => e.childModelPath === pathOf(2))!;
    expect(e12.parentModelPath).toBe(pathOf(1));
    expect(e12.deltaOfv).toBeCloseTo(-13.7, 1);
    expect(e12.color).toBe('green');

    const e23 = g.edges.find((e) => e.childModelPath === pathOf(3))!;
    expect(e23.parentModelPath).toBe(pathOf(2));
    expect(e23.deltaOfv).toBeCloseTo(-2.7, 1);
    expect(e23.color).toBe('yellow');
  });

  it('paints worsening child red and computeDeltaOfv=false gray (regardless of OFV)', () => {
    const g = buildLineageGraph([
      input(1, 4612.4, null),
      input(2, 4617.9, 1),
      input(3, 4500.0, 1, false),
    ]);
    const e12 = g.edges.find((e) => e.childModelPath === pathOf(2))!;
    expect(e12.color).toBe('red');
    const e13 = g.edges.find((e) => e.childModelPath === pathOf(3))!;
    expect(e13.color).toBe('gray');
    expect(e13.deltaOfv).toBeNull();
  });

  it('orphan child (parent runNumber not in input set) becomes a root, no edge emitted', () => {
    const g = buildLineageGraph([input(1, 4612.4, null), input(7, 4500.0, 99)]);
    expect(g.edges.length).toBe(0);
    expect(new Set(g.roots)).toEqual(new Set([pathOf(1), pathOf(7)]));
  });

  it('null parent OFV (parent run aborted) → gray edge with null ΔOFV', () => {
    const g = buildLineageGraph([input(1, null, null), input(2, 4500.0, 1)]);
    const e = g.edges[0];
    expect(e.color).toBe('gray');
    expect(e.deltaOfv).toBeNull();
  });

  it('multiple children of the same parent each get their own edge with own color', () => {
    const g = buildLineageGraph([input(1, 4612.4, null), input(2, 4598.7, 1), input(3, 4617.9, 1)]);
    expect(g.edges.length).toBe(2);
    expect(new Set(g.edges.map((e) => e.color))).toEqual(new Set(['green', 'red']));
    expect(g.roots).toEqual([pathOf(1)]);
  });

  it('boundary: ΔOFV ≥ +3.84 → red, ≤ -3.84 → green; |Δ|<3.84 → yellow (Keizer 2013)', () => {
    const g = buildLineageGraph([input(1, 100, null), input(2, 103.84, 1), input(3, 103.83, 1)]);
    expect(g.edges.find((e) => e.childModelPath === pathOf(2))!.color).toBe('red');
    expect(g.edges.find((e) => e.childModelPath === pathOf(3))!.color).toBe('yellow');
  });

  it('preserves description / label from input on the node payload', () => {
    const g = buildLineageGraph([
      { ...input(1, 4612.4, null), description: 'Base 1-cmpt', label: 'final' },
    ]);
    expect(g.nodes[0].description).toBe('Base 1-cmpt');
    expect(g.nodes[0].label).toBe('final');
  });

  it('self-reference (`;; Based on: N` where N == own runNumber) becomes a root, no edge', () => {
    const g = buildLineageGraph([input(1, 100, null), input(2, 95, 2)]);
    expect(g.edges).toEqual([]);
    expect(new Set(g.roots)).toEqual(new Set([pathOf(1), pathOf(2)]));
  });

  it('cycle (run002→3, run003→2) — both nodes become roots, no edges drawn', () => {
    const g = buildLineageGraph([input(2, 100, 3), input(3, 95, 2)]);
    expect(g.edges).toEqual([]);
    expect(new Set(g.roots)).toEqual(new Set([pathOf(2), pathOf(3)]));
    expect(g.nodes.length).toBe(2);
  });

  it('same `run<NNN>` in two subdirs → both nodes preserved (different modelPaths), only first claims the runNumber', () => {
    // Identity changed in v0.0.79 from runNumber→modelPath. Two
    // run001.mod files in different dirs are distinct nodes; the
    // first one claims runNumber=1 for parent-resolution purposes.
    const a = { ...input(1, 100, null), modelPath: '/a/run001.mod' };
    const b = { ...input(1, 999, null), modelPath: '/b/run001.mod' };
    const g = buildLineageGraph([a, b]);
    expect(g.nodes).toHaveLength(2);
    expect(new Set(g.nodes.map((n) => n.modelPath))).toEqual(
      new Set(['/a/run001.mod', '/b/run001.mod']),
    );
    expect(new Set(g.roots)).toEqual(new Set(['/a/run001.mod', '/b/run001.mod']));
  });

  it('orphan / unconventionally-named models (Pirana m.mod, hand-rolled names) appear as roots', () => {
    // The user's "we have so many runs/lsts lying around without lineage"
    // case — non-numbered models still become nodes so the modeler
    // can construct lineage in hindsight via Edit Run Notes.
    const orphan: LineageNodeInput = {
      runNumber: null,
      modelPath: '/work/colistin.mod',
      lstPath: '/work/colistin.lst',
      phiPath: null,
      basename: 'colistin',
      description: null,
      label: null,
      ofv: 4500,
      termination: null,
      dataFile: null,
      basedOn: null,
      computeDeltaOfv: true,
    };
    const g = buildLineageGraph([input(1, 4612.4, null), orphan]);
    expect(g.nodes.map((n) => n.basename).sort()).toEqual(['colistin', 'run001']);
    expect(new Set(g.roots)).toEqual(new Set([pathOf(1), '/work/colistin.mod']));
    expect(g.edges).toEqual([]);
  });

  it('orphan model can be a parent target (numbered model bases on numeric → resolves)', () => {
    // run002 ;; Based on: 1 — resolves whichever numbered run exists,
    // regardless of how the parent file is named (it just needs runNumber).
    const g = buildLineageGraph([input(1, 100, null), input(2, 95, 1)]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].parentModelPath).toBe(pathOf(1));
  });

  it('basedOnPath override wires any-to-any runs (Pirana m.mod → run<NNN>, etc.)', () => {
    // Pirana-style child references a numbered parent via path override.
    // Without this, `;; Based on:` is integer-only and m.mod can't have
    // a runrecord-compatible parent declaration.
    const orphanChild: LineageNodeInput = {
      runNumber: null,
      modelPath: '/work/colistin.mod',
      lstPath: '/work/colistin.lst',
      phiPath: null,
      basename: 'colistin',
      description: null,
      label: null,
      ofv: 4500,
      termination: null,
      dataFile: null,
      basedOn: null,
      computeDeltaOfv: true,
      basedOnPath: pathOf(1),
    };
    const g = buildLineageGraph([input(1, 4612, null), orphanChild]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].parentModelPath).toBe(pathOf(1));
    expect(g.edges[0].childModelPath).toBe('/work/colistin.mod');
  });

  it('basedOnPath: null forces root status (overrides any `;; Based on:` marker)', () => {
    // run002 has `;; Based on: 1` from the .mod runrecord, but the
    // workspace override pinned it as a root. Override wins.
    const child = { ...input(2, 95, 1), basedOnPath: null as string | null };
    const g = buildLineageGraph([input(1, 100, null), child]);
    expect(g.edges).toEqual([]);
    expect(new Set(g.roots)).toEqual(new Set([pathOf(1), pathOf(2)]));
  });

  it('same basename in different folders are distinct nodes (Improve-style step1/run1.mod, step2/run1.mod)', () => {
    const a: LineageNodeInput = {
      runNumber: 1,
      modelPath: '/proj/step1/run1.mod',
      lstPath: '/proj/step1/run1.lst',
      phiPath: null,
      basename: 'run1',
      description: null,
      label: null,
      ofv: 100,
      termination: null,
      dataFile: null,
      basedOn: null,
      computeDeltaOfv: true,
    };
    const b: LineageNodeInput = {
      ...a,
      modelPath: '/proj/step2/run1.mod',
      lstPath: '/proj/step2/run1.lst',
      ofv: 95,
      // Step2's run1 is wired as a child of step1's run1 via path override.
      basedOnPath: '/proj/step1/run1.mod',
    };
    const g = buildLineageGraph([a, b]);
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].parentModelPath).toBe('/proj/step1/run1.mod');
    expect(g.edges[0].childModelPath).toBe('/proj/step2/run1.mod');
  });

  it('basedOnPath cycle detection (A → B → A via overrides) — both become roots', () => {
    const a: LineageNodeInput = {
      ...input(1, 100, null),
      modelPath: '/a.mod',
      basename: 'a',
      basedOnPath: '/b.mod',
    };
    const b: LineageNodeInput = {
      ...input(2, 95, null),
      modelPath: '/b.mod',
      basename: 'b',
      basedOnPath: '/a.mod',
    };
    const g = buildLineageGraph([a, b]);
    expect(g.edges).toEqual([]);
    expect(new Set(g.roots)).toEqual(new Set(['/a.mod', '/b.mod']));
  });

  it('edge from numeric basedOn marks viaOverride=false', () => {
    const g = buildLineageGraph([input(1, 100, null), input(2, 95, 1)]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].viaOverride).toBe(false);
  });

  it('edge from basedOnPath string override marks viaOverride=true', () => {
    const child: LineageNodeInput = {
      ...input(2, 95, null),
      basedOnPath: pathOf(1),
    };
    const g = buildLineageGraph([input(1, 100, null), child]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].viaOverride).toBe(true);
  });
});

describe('LineageGraph.unresolvedParentCount', () => {
  // The view-side diagnostic that surfaces "N runs reference a parent
  // that's not in this view" — typically a Pirana / hand-rolled run
  // referencing a numbered parent that hasn't been imported, or a
  // workspace override pointing at a path the user later renamed.
  // Cycle nodes are NOT counted here (they have a different cause and
  // are surfaced separately).

  it('unresolvedParentCount: 0 when every parent ref resolves', () => {
    const g = buildLineageGraph([input(1, 100, null), input(2, 95, 1)]);
    expect(g.unresolvedParentCount).toBe(0);
  });

  it('unresolvedParentCount: numeric `;; Based on: N` referencing a missing run counts as unresolved', () => {
    const g = buildLineageGraph([input(1, 100, null), input(2, 95, 99)]);
    expect(g.unresolvedParentCount).toBe(1);
  });

  it('unresolvedParentCount: basedOnPath pointing at a path not in inputs counts as unresolved', () => {
    const child: LineageNodeInput = {
      ...input(2, 95, null),
      basedOnPath: '/never/existed.mod',
    };
    const g = buildLineageGraph([input(1, 100, null), child]);
    expect(g.unresolvedParentCount).toBe(1);
  });
});

describe('wouldOverrideCreateCycle', () => {
  // Predicate used by the panel before persisting a parent override.
  // Walks UP from `parentPath` via current edges; cycle iff it reaches
  // `childPath` (i.e. the proposed parent has the proposed child as an
  // ancestor, so wiring child→parent would close a loop).
  const edge = (parent: string, child: string): LineageEdge => ({
    parentModelPath: parent,
    childModelPath: child,
    deltaOfv: null,
    color: 'gray',
    viaOverride: false,
  });

  it('self-reference (childPath === parentPath) is a cycle', () => {
    expect(wouldOverrideCreateCycle([], '/a.mod', '/a.mod')).toBe(true);
  });

  it('chain A→B→C, setting A.parent = C creates cycle (C is descendant of A)', () => {
    const edges = [edge('/a.mod', '/b.mod'), edge('/b.mod', '/c.mod')];
    expect(wouldOverrideCreateCycle(edges, '/a.mod', '/c.mod')).toBe(true);
  });

  it('chain A→B→C, setting C.parent = A is a re-tree, not a cycle', () => {
    // C's existing parent (B) gets replaced by A. A has no ancestor that
    // is C, so no cycle. Walking up from A: A has no parent → false.
    const edges = [edge('/a.mod', '/b.mod'), edge('/b.mod', '/c.mod')];
    expect(wouldOverrideCreateCycle(edges, '/c.mod', '/a.mod')).toBe(false);
  });
});
