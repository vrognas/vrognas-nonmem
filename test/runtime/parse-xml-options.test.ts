import { describe, it, expect } from 'vitest';
import { parseEstimationOptions } from '../../src/runtime/parse-xml-options';

// Captured from probe-signals/test-signals/.../psn.xml (NM 7.6.0). Two
// chained $EST steps -> two <nm:estimation_options> elements with
// different attribute subsets (SAEM has kernel-sampling knobs; IMP
// EONLY has IS-specific ones).
const TWO_STEPS_XML = `<?xml version="1.0" encoding="ASCII"?>
<nm:output xmlns:nm="...">
<nm:estimation_options
 nm:estimation_method='saem' nm:nburn='1000' nm:niter='200' nm:isample='2'
 nm:ctype='3' nm:calpha='5.000000000000000E-02' nm:eonly='0'
 nm:isample_m1='2' nm:ikappa='1.00000000000000' nm:massreset='-1'
/>
<nm:estimation_options
 nm:estimation_method='imp' nm:niter='5' nm:isample='3000' nm:eonly='1'
 nm:df='0' nm:mapcov='1' nm:grdq='0.00000000000000'
/>
</nm:output>`;

describe('parseEstimationOptions', () => {
  it('extracts each <nm:estimation_options/> element with all attributes', () => {
    const steps = parseEstimationOptions(TWO_STEPS_XML);
    expect(steps).toHaveLength(2);

    const saem = steps[0];
    expect(saem.estimation_method).toBe('saem');
    expect(saem.nburn).toBe('1000');
    expect(saem.niter).toBe('200');
    expect(saem.calpha).toBe('5.000000000000000E-02');
    expect(saem.massreset).toBe('-1');

    const imp = steps[1];
    expect(imp.estimation_method).toBe('imp');
    expect(imp.eonly).toBe('1');
    expect(imp.isample).toBe('3000');
    expect(imp.df).toBe('0');
    // SAEM-only knobs absent from IMP step
    expect(imp.nburn).toBeUndefined();
    expect(imp.massreset).toBeUndefined();
  });

  it('handles double-quoted attribute values too', () => {
    const xml = `<nm:estimation_options nm:method="foce" nm:maxeval="9999"/>`;
    const steps = parseEstimationOptions(xml);
    expect(steps).toHaveLength(1);
    expect(steps[0].method).toBe('foce');
    expect(steps[0].maxeval).toBe('9999');
  });

  it('returns [] for empty / non-XML / pre-NM7.2 input', () => {
    expect(parseEstimationOptions('')).toEqual([]);
    expect(parseEstimationOptions('garbage; not xml')).toEqual([]);
    // Older NM emitted .xml without nm:estimation_options at all
    expect(parseEstimationOptions('<nm:output></nm:output>')).toEqual([]);
  });

  it("rejects rather than truncates when a value contains a > char (defensive)", () => {
    // NM7 doesn't emit such values empirically, but the regex must
    // not silently produce a truncated attribute dictionary on
    // unexpected input. With `[^>]*?` the whole element is rejected;
    // we'd rather return [] and miss the surface than show wrong data.
    const xml = `<nm:estimation_options nm:foo='a>b' nm:bar='ok'/>`;
    expect(parseEstimationOptions(xml)).toEqual([]);
  });
});
