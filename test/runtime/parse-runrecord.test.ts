import { describe, it, expect } from 'vitest';
import { parseRunrecord, setBasedOn } from '../../src/runtime/parse-runrecord';

describe('parseRunrecord', () => {
  it('parses `;; Based on: N` as basedOn number', () => {
    const text = `$PROBLEM Test
;; Based on: 1
$INPUT ID TIME DV
`;
    const r = parseRunrecord(text);
    expect(r.basedOn).toBe(1);
    expect(r.computeDeltaOfv).toBe(true);
  });

  it('accepts the optional numbered prefix (;; 1. Based on: 5)', () => {
    const text = `$PROBLEM Test
;; 1. Based on: 5
$INPUT ID
`;
    expect(parseRunrecord(text).basedOn).toBe(5);
  });

  it('honors `[nodOFV]` modifier — basedOn still set, computeDeltaOfv flips false', () => {
    const text = `$PROBLEM Test
;; Based on: 2 [nodOFV]
$INPUT ID
`;
    const r = parseRunrecord(text);
    expect(r.basedOn).toBe(2);
    expect(r.computeDeltaOfv).toBe(false);
  });

  it('returns null basedOn when no marker is present', () => {
    expect(parseRunrecord(`$PROBLEM Test\n$INPUT ID\n`).basedOn).toBeNull();
  });

  it('parses other tags into the tags map (Description, Label, ...)', () => {
    const text = `$PROBLEM Test
;; Based on: 1
;; Description:
;; Added an OMEGA BLOCK(2)
;; Label:
;; Basic model
$INPUT ID
`;
    const r = parseRunrecord(text);
    expect(r.tags.get('Description')).toBe('Added an OMEGA BLOCK(2)');
    expect(r.tags.get('Label')).toBe('Basic model');
    // Based on is the special case — it's NOT in the generic tags map.
    expect(r.tags.has('Based on')).toBe(false);
  });

  it('joins multi-line bodies with a newline for non-Based-on tags', () => {
    const text = `$PROBLEM Test
;; Description:
;; Line 1
;; Line 2 of description
;; Label:
;; My label
$INPUT ID
`;
    expect(parseRunrecord(text).tags.get('Description')).toBe('Line 1\nLine 2 of description');
  });

  it('handles an empty-body tag (just `;; <Tag>:` with no continuation lines)', () => {
    const text = `$PROBLEM Test
;; Interoccasion variability:
;; Based on: 1
$INPUT ID
`;
    const r = parseRunrecord(text);
    expect(r.tags.get('Interoccasion variability')).toBe('');
    expect(r.basedOn).toBe(1);
  });

  it('returns null when no $PROBLEM record exists in the file', () => {
    expect(parseRunrecord(`; just a comment\n$INPUT ID\n`).basedOn).toBeNull();
  });

  it('continuation line containing `<word>:<word>` does NOT shadow the active tag (B6)', () => {
    // Without the stricter tag-name regex, `;; uses ITS:FOCE first`
    // would parse as a new tag named "uses ITS" with body "FOCE first",
    // wiping out the parent Description's continuation.
    const text = `$PROBLEM Test
;; Description:
;; Phase 2 model
;; uses ITS:FOCE first then COND
$INPUT ID
`;
    const r = parseRunrecord(text);
    expect(r.tags.get('Description')).toBe('Phase 2 model\nuses ITS:FOCE first then COND');
    // Phantom tag must NOT have been created.
    expect(r.tags.has('uses ITS')).toBe(false);
  });

  it('stops parsing the runrecord block at the first non-`;;` line', () => {
    // Single-`;` line is a regular NMTRAN comment, not runrecord — ends the block.
    // Everything after that should be ignored even if `;;` resumes.
    const text = `$PROBLEM Test
;; Based on: 1
; regular comment that ends runrecord
;; Label: should not be parsed
$INPUT ID
`;
    const r = parseRunrecord(text);
    expect(r.basedOn).toBe(1);
    expect(r.tags.get('Label')).toBeUndefined();
  });
});

describe('setBasedOn', () => {
  it('inserts `;; Based on: N` directly below $PROBLEM when no marker exists', () => {
    const text = `$PROBLEM Test
$INPUT ID TIME DV
$DATA d.csv
`;
    const out = setBasedOn(text, 1);
    expect(out).toContain('$PROBLEM Test\n;; Based on: 1\n$INPUT ID');
  });

  it('replaces an existing `;; Based on:` instead of duplicating it (idempotent re-promote)', () => {
    const text = `$PROBLEM Test
;; Based on: 1
$INPUT ID
`;
    const out = setBasedOn(text, 2);
    // Single marker, with the new value.
    expect(out.match(/;; Based on:/g)?.length).toBe(1);
    expect(out).toContain(';; Based on: 2');
    expect(out).not.toContain(';; Based on: 1');
  });

  it('replaces a numbered-prefix marker (;; 1. Based on: …) too', () => {
    const text = `$PROBLEM Test
;; 1. Based on: 5
;; 2. Description:
;; Existing description
$INPUT ID
`;
    const out = setBasedOn(text, 9);
    expect(out.match(/Based on:/g)?.length).toBe(1);
    expect(out).toContain(';; Based on: 9');
    // Description preserved.
    expect(out).toContain(';; Existing description');
  });

  it('accepts `$PROB` (short form) as well as `$PROBLEM`', () => {
    const text = `$PROB Cubic\n$INPUT ID\n`;
    expect(setBasedOn(text, 3)).toContain('$PROB Cubic\n;; Based on: 3\n');
  });

  it('returns the original text unchanged when no $PROB record exists (defensive)', () => {
    const text = `$INPUT ID\n$DATA d.csv\n`;
    expect(setBasedOn(text, 1)).toBe(text);
  });

  it('preserves `[nodOFV]` when the parent number stays the same (idempotent re-promote, B7)', () => {
    const text = `$PROBLEM Test
;; Based on: 2 [nodOFV]
$INPUT ID
`;
    const out = setBasedOn(text, 2);
    expect(out).toContain(';; Based on: 2 [nodOFV]');
    // No duplicates.
    expect(out.match(/;; Based on:/g)?.length).toBe(1);
  });

  it('preserves CRLF line endings when rewriting (no spurious whole-file diff, B9)', () => {
    const text = '$PROBLEM Test\r\n$INPUT ID\r\n$DATA d.csv\r\n';
    const out = setBasedOn(text, 1);
    // Output should still be CRLF — without preservation, every promote
    // would silently rewrite line endings.
    expect(out).toContain('\r\n');
    // Specifically, the inserted line should also use CRLF.
    expect(out).toMatch(/;; Based on: 1\r\n/);
  });

  it('drops `[nodOFV]` when the parent number changes (modifier described old pair, B7)', () => {
    const text = `$PROBLEM Test
;; Based on: 2 [nodOFV]
$INPUT ID
`;
    const out = setBasedOn(text, 5);
    expect(out).toContain(';; Based on: 5');
    expect(out).not.toContain('[nodOFV]');
  });
});
