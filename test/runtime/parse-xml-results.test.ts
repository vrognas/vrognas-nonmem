import { describe, it, expect } from 'vitest';
import { parseEstimationResults } from '../../src/runtime/parse-xml-results';

// Captured shape from probe-signals/test-signals/.../psn.xml. Step 1
// is SAEM (burn-in present), step 2 is IMP-EONLY (no burn-in field).
// Termination status 0 = success, 2 = failed precision (used for
// step 2 here to confirm parse works on non-zero codes).
const TWO_STEPS_XML = `<nm:output>
<nm:estimation nm:number='1' nm:type='0'>
  <nm:estimation_method>saem</nm:estimation_method>
  <nm:termination_status>0</nm:termination_status>
  <nm:estimation_burnin_time>15.41</nm:estimation_burnin_time>
  <nm:estimation_elapsed_time>24.82</nm:estimation_elapsed_time>
</nm:estimation>
<nm:estimation nm:number='2' nm:type='0'>
  <nm:estimation_method>imp</nm:estimation_method>
  <nm:termination_status>2</nm:termination_status>
  <nm:estimation_elapsed_time>13.01</nm:estimation_elapsed_time>
</nm:estimation>
</nm:output>`;

describe('parseEstimationResults', () => {
  it('extracts number, termination_status, burnin + elapsed time per step', () => {
    const steps = parseEstimationResults(TWO_STEPS_XML);
    expect(steps).toHaveLength(2);

    expect(steps[0].number).toBe(1);
    expect(steps[0].terminationStatus).toBe(0);
    expect(steps[0].burninTime).toBeCloseTo(15.41, 4);
    expect(steps[0].elapsedTime).toBeCloseTo(24.82, 4);

    expect(steps[1].number).toBe(2);
    expect(steps[1].terminationStatus).toBe(2);
    // IMP-EONLY has no burn-in concept; field absent in XML -> null.
    expect(steps[1].burninTime).toBeNull();
    expect(steps[1].elapsedTime).toBeCloseTo(13.01, 4);
  });

  it('handles scientific-notation timing values (long runs)', () => {
    const xml = `<nm:estimation nm:number='1' nm:type='0'>
  <nm:termination_status>0</nm:termination_status>
  <nm:estimation_elapsed_time>1.234E+03</nm:estimation_elapsed_time>
</nm:estimation>`;
    const [step] = parseEstimationResults(xml);
    expect(step.elapsedTime).toBeCloseTo(1234, 2);
  });

  it('returns [] for empty / pre-NM7.2 / aborted-before-results input', () => {
    expect(parseEstimationResults('')).toEqual([]);
    expect(parseEstimationResults('garbage; not xml')).toEqual([]);
    // XML present but no <nm:estimation> blocks (aborted run, only
    // control_stream + nmtran sections written).
    expect(parseEstimationResults('<nm:output></nm:output>')).toEqual([]);
  });
});
