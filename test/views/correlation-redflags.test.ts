import { describe, it, expect } from 'vitest';
import { findCorrelationRedFlags } from '../../src/views/correlation-redflags';
import type { CorTable } from '../../src/runtime/parse-cor';

function buildTable(values: Record<string, Record<string, number>>): CorTable {
  const paramNames = Object.keys(values);
  const map = new Map<string, Map<string, number>>();
  for (const a of paramNames) {
    const inner = new Map<string, number>();
    for (const b of paramNames) inner.set(b, values[a][b]);
    map.set(a, inner);
  }
  return { method: 'FOCE-INTER', paramNames, values: map };
}

describe('findCorrelationRedFlags', () => {
  it('classifies into warn/bad tiers, sorted by |r| desc, diagonal + lower-tri excluded', () => {
    // 3×3 symmetric matrix:
    //   THETA1↔SIGMA: 0.97  (≥ 0.95 → bad)
    //   THETA1↔OMEGA: -0.92 (in [0.90, 0.95) → warn)
    //   SIGMA↔OMEGA:  0.42  (< 0.90 → drop)
    const t = buildTable({
      THETA1: { THETA1: 1, 'SIGMA(1,1)': 0.97, 'OMEGA(1,1)': -0.92 },
      'SIGMA(1,1)': { THETA1: 0.97, 'SIGMA(1,1)': 1, 'OMEGA(1,1)': 0.42 },
      'OMEGA(1,1)': { THETA1: -0.92, 'SIGMA(1,1)': 0.42, 'OMEGA(1,1)': 1 },
    });
    const flags = findCorrelationRedFlags(t, 0.9, 0.95);
    expect(flags).toHaveLength(2);
    // |0.97| > |-0.92|, so THETA-SIGMA comes first.
    expect(flags[0]).toEqual({ a: 'THETA1', b: 'SIGMA(1,1)', r: 0.97, kind: 'bad' });
    expect(flags[1]).toEqual({ a: 'THETA1', b: 'OMEGA(1,1)', r: -0.92, kind: 'warn' });
  });

  it('symmetric pair counted once (upper-triangle scan); kind reflects |r| not sign', () => {
    // Pair THETA1↔OMEGA appears in both .values.get('THETA1').get('OMEGA')
    // AND .values.get('OMEGA').get('THETA1'). Must be returned once.
    // Negative correlation classifies the same as positive at same |r|.
    const t = buildTable({
      THETA1: { THETA1: 1, 'OMEGA(1,1)': -0.99 },
      'OMEGA(1,1)': { THETA1: -0.99, 'OMEGA(1,1)': 1 },
    });
    expect(findCorrelationRedFlags(t, 0.9, 0.95)).toEqual([
      { a: 'THETA1', b: 'OMEGA(1,1)', r: -0.99, kind: 'bad' },
    ]);
  });

  it('returns [] for null table or all-zero matrix (no $COV ran) or below warn threshold', () => {
    expect(findCorrelationRedFlags(null, 0.9, 0.95)).toEqual([]);
    const allZero = buildTable({
      THETA1: { THETA1: 0, 'OMEGA(1,1)': 0 },
      'OMEGA(1,1)': { THETA1: 0, 'OMEGA(1,1)': 0 },
    });
    expect(findCorrelationRedFlags(allZero, 0.9, 0.95)).toEqual([]);
    const lowCorr = buildTable({
      THETA1: { THETA1: 1, 'OMEGA(1,1)': 0.42 },
      'OMEGA(1,1)': { THETA1: 0.42, 'OMEGA(1,1)': 1 },
    });
    expect(findCorrelationRedFlags(lowCorr, 0.9, 0.95)).toEqual([]);
  });
});
