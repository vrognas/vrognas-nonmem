// Parse the runtime-resolved tolerance / sig-digits trace from the
// `.lst`. NM 7.6.0 emits up to four blocks within the first 100-200
// lines after the control-stream echo, each carrying the value
// actually used at runtime — distinct from the XML wire format which
// can have sentinel values (e.g. `atol='0'` is a sentinel for the
// runtime built-in default 12; empirically verified at
// `~/positron-nonmem/probe-resolved/`).
//
// Trace layout (only some blocks emitted depending on $SUBROUTINES /
// $EST / $COV configuration):
//
//   INITIAL (BASE) TOLERANCE SETTINGS:
//    NRD (RELATIVE) VALUE(S) OF TOLERANCE:   6
//    ANRD (ABSOLUTE) VALUE(S) OF TOLERANCE:  12
//
//   SIGDIGITS FOR MAP ESTIMATION (SIGLO):    100
//   GRADIENT SIGDIGITS OF
//         FIXED EFFECTS PARAMETERS (SIGL):     100
//
//   TOLERANCES FOR ESTIMATION/EVALUATION STEP:
//    NRD (RELATIVE) VALUE(S) OF TOLERANCE:   6
//    ANRD (ABSOLUTE) VALUE(S) OF TOLERANCE:  10
//
//   TOLERANCES FOR COVARIANCE STEP:
//    NRD (RELATIVE) VALUE(S) OF TOLERANCE:   6
//    ANRD (ABSOLUTE) VALUE(S) OF TOLERANCE:  10
//
// Used by the Fit Inspector to surface "wire vs runtime" annotations
// on $EST/$COV options whose XML emit is a sentinel.

/**
 * Runtime-resolved tolerance + sig-digits values pulled from the .lst
 * trace. Each field is null when the trace block wasn't emitted (e.g.
 * non-ODE models lack the BASE TOLERANCE block; runs without $COV
 * lack the COVARIANCE block). Numeric strings as NM emits them — no
 * type coercion so the inspector renders the same precision NM did.
 */
export interface LstTolerances {
  /** Built-in base relative tolerance (NRD), pre-$EST/$COV override. */
  baseNrd: string | null;
  /** Built-in base absolute tolerance (ANRD). Typically 12. */
  baseAnrd: string | null;
  /** Resolved $EST step relative tolerance. */
  estNrd: string | null;
  /** Resolved $EST step absolute tolerance. */
  estAnrd: string | null;
  /** Resolved $COV step relative tolerance. */
  covNrd: string | null;
  /** Resolved $COV step absolute tolerance. */
  covAnrd: string | null;
  /** Resolved SIGLO (MAP estimation sig-digits target). Typically 100. */
  siglo: string | null;
  /** Resolved SIGL (gradient sig-digits target). Typically 100. */
  sigl: string | null;
}

const EMPTY: LstTolerances = {
  baseNrd: null,
  baseAnrd: null,
  estNrd: null,
  estAnrd: null,
  covNrd: null,
  covAnrd: null,
  siglo: null,
  sigl: null,
};

/**
 * Extract the numeric value at the end of a trace line, e.g.
 * "  NRD (RELATIVE) VALUE(S) OF TOLERANCE:   6" → "6". Tolerant of
 * decimal values, scientific notation, and varying whitespace. Returns
 * null when the regex doesn't match.
 */
function extractTrailingNumber(line: string): string | null {
  const m = line.match(/:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*$/);
  return m ? m[1] : null;
}

/**
 * Parse all tolerance / sig-digits trace blocks from a `.lst`. Returns
 * a sparse `LstTolerances` object — fields are null when the
 * corresponding block wasn't emitted in the .lst.
 */
export function parseLstTolerances(lstText: string): LstTolerances {
  const result: LstTolerances = { ...EMPTY };
  const lines = lstText.split(/\r?\n/);
  // Anchor on the section-header lines, then read the next NRD/ANRD
  // pair that follows. Each header is unique in the .lst's main body
  // so `indexOf` semantics work even with simple linear scan.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*INITIAL \(BASE\) TOLERANCE SETTINGS:/i.test(line)) {
      readNrdAnrd(lines, i, (nrd, anrd) => {
        result.baseNrd = nrd;
        result.baseAnrd = anrd;
      });
    } else if (/^\s*TOLERANCES FOR ESTIMATION\/EVALUATION STEP:/i.test(line)) {
      readNrdAnrd(lines, i, (nrd, anrd) => {
        result.estNrd = nrd;
        result.estAnrd = anrd;
      });
    } else if (/^\s*TOLERANCES FOR COVARIANCE STEP:/i.test(line)) {
      readNrdAnrd(lines, i, (nrd, anrd) => {
        result.covNrd = nrd;
        result.covAnrd = anrd;
      });
    } else if (/SIGDIGITS FOR MAP ESTIMATION \(SIGLO\)/i.test(line)) {
      result.siglo = extractTrailingNumber(line);
    } else if (/FIXED EFFECTS PARAMETERS \(SIGL\)/i.test(line)) {
      // SIGL line is multi-line in the .lst (split across "GRADIENT
      // SIGDIGITS OF" and "FIXED EFFECTS PARAMETERS (SIGL):" lines).
      // The numeric value lives on the second line; this match anchors
      // there and reads the trailing number directly.
      result.sigl = extractTrailingNumber(line);
    }
  }
  return result;
}

/**
 * Read the next two lines (NRD then ANRD) following a section header
 * line at index `i`. Tolerant of blank lines and the occasional
 * intervening text. Reads at most 4 lines past the header to bound
 * cost on malformed traces.
 */
function readNrdAnrd(
  lines: string[],
  headerIdx: number,
  setBoth: (nrd: string | null, anrd: string | null) => void,
): void {
  let nrd: string | null = null;
  let anrd: string | null = null;
  for (let j = headerIdx + 1; j < Math.min(lines.length, headerIdx + 5); j++) {
    const l = lines[j];
    if (/NRD \(RELATIVE\)/i.test(l)) nrd = extractTrailingNumber(l);
    else if (/ANRD \(ABSOLUTE\)/i.test(l)) anrd = extractTrailingNumber(l);
    if (nrd !== null && anrd !== null) break;
  }
  setBoth(nrd, anrd);
}
