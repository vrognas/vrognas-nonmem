import { describe, it, expect } from 'vitest';
import {
  INSPECTOR_THRESHOLD_DEFAULTS,
  buildInspectorPayload,
} from '../../src/views/fit-inspector-payload';

// `INSPECTOR_THRESHOLD_DEFAULTS` is the single source of truth for the
// 11 user-configurable thresholds. extension.ts reads each value as the
// `cfg.get(key, default)` fallback; the payload builder uses the same
// constant when no override is passed. Drift between these two would
// silently change user behaviour.
//
// These tests lock both ends to the constant. A future bump of any
// default needs to land in the constant only; the payload-default
// shape is asserted symbolically.

describe('INSPECTOR_THRESHOLD_DEFAULTS', () => {
  it('exposes all 11 config-driven threshold keys', () => {
    expect(Object.keys(INSPECTOR_THRESHOLD_DEFAULTS).sort()).toEqual([
      'condNumberBadThreshold',
      'condNumberWarnThreshold',
      'corrRedFlagThreshold',
      'corrWarnThreshold',
      'pValBadThreshold',
      'pValWarnThreshold',
      'rseOmegaWarnPct',
      'rseThetaWarnPct',
      'rseWarnPct',
      'shrinkageBorderlineWarnPct',
      'shrinkageWarnPct',
    ]);
  });

  it('default values match pharmacometric convention', () => {
    expect(INSPECTOR_THRESHOLD_DEFAULTS).toEqual({
      shrinkageWarnPct: 30,
      shrinkageBorderlineWarnPct: 20,
      rseWarnPct: 100,
      rseThetaWarnPct: 30,
      rseOmegaWarnPct: 50,
      pValWarnThreshold: 0.1,
      pValBadThreshold: 0.05,
      corrRedFlagThreshold: 0.95,
      corrWarnThreshold: 0.9,
      condNumberBadThreshold: 1000,
      condNumberWarnThreshold: 100,
    });
  });

  it('payload thresholds match INSPECTOR_THRESHOLD_DEFAULTS when no overrides supplied', () => {
    const payload = buildInspectorPayload(
      { thetas: [], omegas: [], sigmas: [], equations: [], dataFile: null, inputColumns: [] },
      // No `ctx` threshold fields → builder should fall through to defaults.
      {},
    );
    expect(payload).not.toBeNull();
    expect(payload!.thresholds).toMatchObject(INSPECTOR_THRESHOLD_DEFAULTS);
  });
});
