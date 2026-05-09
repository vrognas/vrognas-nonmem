import { describe, it, expect } from 'vitest';
import { parseCovarianceOptions } from '../../src/runtime/parse-xml-problem-options';

describe('parseCovarianceOptions', () => {
  it('returns null when no <nm:problem_options> element is present', () => {
    expect(parseCovarianceOptions('<nm:nonmem><nm:start_datetime/></nm:nonmem>')).toBeNull();
  });

  it('returns null when <nm:problem_options> exists but has no cov_* attrs', () => {
    // Mod with no $COV record — `data_*` and other problem-level
    // attrs are present but no `cov_*`. Distinguishable from the
    // `cov_omitted='yes'` case (explicit user-written `$COV OMITTED`).
    const xml = `<nm:problem_options
 nm:data_unit='2' nm:data_nrec='100' nm:nthetat='2'
/>`;
    expect(parseCovarianceOptions(xml)).toBeNull();
  });

  it('extracts cov_* attrs and strips both nm: and cov_ prefixes', () => {
    const xml = `<nm:problem_options
 nm:data_unit='2' nm:cov_matrix='rsr' nm:cov_thbnd='1' nm:cov_omitted='no'
/>`;
    const opts = parseCovarianceOptions(xml);
    expect(opts).toEqual({ matrix: 'rsr', thbnd: '1', omitted: 'no' });
  });

  it('handles multi-line attrs and double-quoted values', () => {
    const xml = `<nm:problem_options
 nm:cov_matrix="r"
 nm:cov_thbnd='0'
 nm:cov_sirsample="BLANK"
/>`;
    const opts = parseCovarianceOptions(xml);
    expect(opts).toEqual({ matrix: 'r', thbnd: '0', sirsample: 'BLANK' });
  });

  it('uses the first <nm:problem_options> when multiple exist (defensive — NM emits one)', () => {
    const xml = `<nm:problem_options nm:cov_matrix='r' />
<nm:problem_options nm:cov_matrix='s' />`;
    expect(parseCovarianceOptions(xml)?.matrix).toBe('r');
  });
});
