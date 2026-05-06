// Pure parser for fields NONMEM writes into the `.lst` that aren't
// surfaced by `sumo`. Today: estimation method (`#METH:`),
// FOCE-essential `NO. OF SIG. DIGITS IN FINAL EST.:`, termination
// state (`MINIMIZATION SUCCESSFUL` / `TERMINATED + reason`), per-ETA
// `ETABAR` and `ETASHRINKSD(%)`, per-EPS `EPSSHRINKSD(%)`, eigenvalues
// of COR matrix.
//
// NONMEM 7+ allows chained `$EST` blocks (e.g. ITS → FOCE-INTER); each
// emits its own `#METH:` and termination block. The "method" the user
// cares about is typically the LAST one (final convergence step), so
// we take the last occurrence of each marker.
//
// Multi-line value continuations are handled: NONMEM wraps long
// arrays (>~6 ETAs) onto continuation lines that start with leading
// whitespace and contain only numeric tokens. The reader walks those
// lines until it hits an empty line or the next labelled row.

const METH_RE = /^\s*#METH:\s*(.+?)\s*$/;
const SIGDIG_RE = /NO\.\s*OF\s*SIG\.\s*DIGITS\s*IN\s*FINAL\s*EST\.:\s*([\d.]+)/i;
// FOCE / FO use "MINIMIZATION SUCCESSFUL/TERMINATED"; SAEM / IMP / BAYES
// use "OPTIMIZATION WAS COMPLETED/TERMINATED". NONMEM emits these with
// a leading `0` (page-control marker) glued to the first letter (no
// space), so `\b` boundaries don't apply — match the phrase directly.
const TERM_OK_RE = /(MINIMIZATION SUCCESSFUL|OPTIMIZATION (?:WAS )?COMPLETED)/i;
const TERM_FAIL_RE = /((?:MINIMIZATION|OPTIMIZATION) TERMINATED)/i;
const TERM_REASON_RE =
  /(?:MINIMIZATION|OPTIMIZATION)\s+TERMINATED\s*\n([\s\S]*?)(?:\n\s*NO\.|\n\s*#|\n\s*$)/gi;
// SAEM / BAYES: `ITERATIVE LOOP N: Mean Acceptance Rate: 0.42`. The
// last value is the stationary acceptance rate after burn-in; that's
// what pharmacometricians sanity-check (target ~0.20-0.40).
const ACCEPT_RE = /Mean\s+Acceptance\s+Rate:\s+([\d.]+)/gi;
const NUM_TOKEN_RE = /^[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?$/;

export type TerminationState = 'SUCCESSFUL' | 'TERMINATED';

export interface LstSummary {
  /** Verbatim method label from `#METH:`. */
  method: string | null;
  /** Compact display label derived from `method` (e.g. `FOCE-INTER`). */
  methodShort: string | null;
  /** `NO. OF SIG. DIGITS IN FINAL EST.:` value; null when UNREPORTABLE / absent. */
  sigDigits: number | null;
  /** Last `$EST` step's termination state, or null when absent. */
  termination: TerminationState | null;
  /** Verbatim termination phrase (`MINIMIZATION SUCCESSFUL` / `OPTIMIZATION WAS COMPLETED` / `MINIMIZATION TERMINATED`); display-only — `termination` carries the OK/FAIL bit. */
  terminationPhrase: string | null;
  /** Multi-line reason text following `MINIMIZATION TERMINATED` (e.g. "DUE TO ROUNDING ERRORS (ERROR=134)"); null when SUCCESSFUL or absent. */
  terminationReason: string | null;
  /** Per-ETA mean of estimates (`ETABAR:` row). */
  etabar: number[];
  /** Per-ETA shrinkage on the SD scale (`ETASHRINKSD(%)`). */
  etaShrinkSd: number[];
  /** Per-EPS shrinkage on the SD scale (`EPSSHRINKSD(%)`). */
  epsShrinkSd: number[];
  /** Eigenvalues from `EIGENVALUES OF COR MATRIX OF ESTIMATE`; empty when no $COV ran. */
  eigenvalues: number[];
  /** SAEM / BAYES "Mean Acceptance Rate" — last (stationary) value across iterative loops. Null when the method doesn't emit one (FOCE / FO / IMP). */
  acceptanceRate: number | null;
  /**
   * Per-parameter `NUMSIGDIG:` values from the LAST iteration block.
   * Same column order as the `.ext` header (THETA1 … OMEGA(i,j) …
   * SIGMA(i,j)). Empty when the .lst doesn't emit one. The caller
   * pairs these with `.ext` column names to produce per-row sig-digits.
   */
  numSigDigPerParam: number[];
}

/**
 * Parse the `.lst` text and return the LAST-$EST view of the parsed
 * fields. All-empty / null result when the file contains no recognised
 * markers (read failed / pre-NM7 format / aborted-before-estimation).
 */
export function parseLst(lstText: string): LstSummary {
  const lines = lstText.split(/\r?\n/);
  let method: string | null = null;
  let sigDigits: number | null = null;
  let termination: TerminationState | null = null;
  let terminationPhrase: string | null = null;

  for (const line of lines) {
    const m = line.match(METH_RE);
    if (m) {
      method = m[1].trim();
      continue;
    }
    const s = line.match(SIGDIG_RE);
    if (s) {
      const v = Number(s[1]);
      sigDigits = Number.isFinite(v) ? v : null;
    }
    const ok = line.match(TERM_OK_RE);
    if (ok) {
      termination = 'SUCCESSFUL';
      terminationPhrase = ok[1].toUpperCase();
      continue;
    }
    const fail = line.match(TERM_FAIL_RE);
    if (fail) {
      termination = 'TERMINATED';
      terminationPhrase = fail[1].toUpperCase();
    }
  }

  // Termination reason: only meaningful when the FINAL `$EST` step
  // ended in TERMINATED. Multi-`$EST` chains (e.g. ITS warmup → FOCE)
  // can have a TERMINATED step earlier and a SUCCESSFUL step at the
  // end; we take the LAST occurrence of the reason text and only when
  // the final-step state was TERMINATED.
  let terminationReason: string | null = null;
  if (termination === 'TERMINATED') {
    const reasonMatches = [...lstText.matchAll(TERM_REASON_RE)];
    const last = reasonMatches[reasonMatches.length - 1];
    if (last) {
      terminationReason =
        last[1]
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !/^NO\./i.test(l))
          .join('\n')
          .trim() || null;
    }
  }

  // Acceptance rate: take the LAST `Mean Acceptance Rate:` across the
  // iterative loops (SAEM / BAYES). FOCE / IMP runs don't emit it,
  // leaving acceptanceRate null.
  let acceptanceRate: number | null = null;
  const acceptMatches = [...lstText.matchAll(ACCEPT_RE)];
  if (acceptMatches.length > 0) {
    const v = Number(acceptMatches[acceptMatches.length - 1][1]);
    if (Number.isFinite(v)) acceptanceRate = v;
  }

  return {
    method,
    methodShort: shortMethodLabel(method),
    sigDigits,
    termination,
    terminationPhrase,
    terminationReason,
    etabar: readNumericRow(lines, 'ETABAR'),
    etaShrinkSd: readNumericRow(lines, 'ETASHRINKSD\\(%\\)'),
    epsShrinkSd: readNumericRow(lines, 'EPSSHRINKSD\\(%\\)'),
    eigenvalues: readEigenvalues(lines),
    acceptanceRate,
    numSigDigPerParam: readNumericRow(lines, 'NUMSIGDIG'),
  };
}

/**
 * Compress a verbose NONMEM method name to a compact display label.
 * Pass-through when the name doesn't match a known pattern (covers
 * future methods / wording tweaks without breaking the inspector).
 */
export function shortMethodLabel(method: string | null): string | null {
  if (method === null) return null;
  const m = method.toLowerCase();
  // Order matters: more-specific patterns first.
  if (m.includes('first order conditional') && m.includes('interaction')) return 'FOCE-INTER';
  if (m.includes('first order conditional')) return 'FOCE';
  if (m.includes('iterative two stage')) return 'ITS';
  if (m.includes('stochastic approximation')) return 'SAEM';
  if (m.includes('importance sampling')) return 'IMP';
  if (m.includes('bayesian')) return 'BAYES';
  if (m === 'first order') return 'FO';
  return method;
}

/**
 * Read a labelled row of space-separated numbers, including any
 * continuation lines NONMEM wrote when the values overflow one line
 * (typical for `ETABAR` / `ETASHRINKSD(%)` once N_ETAs > ~6). A
 * continuation line starts with leading whitespace and contains
 * only numeric tokens — no label.
 *
 * The label is interpreted as a regex fragment so callers can
 * include `(`, `)`, `%`, etc. Returns [] when no matching label is
 * present. Picks the LAST occurrence of the label, matching the
 * "last $EST step" rule used throughout this parser.
 */
function readNumericRow(lines: string[], labelPattern: string): number[] {
  const re = new RegExp(`^\\s*${labelPattern}\\s*:?\\s+(.+)$`);
  let startIdx = -1;
  let firstRowRest = '';
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) {
      startIdx = i;
      firstRowRest = m[1];
    }
  }
  if (startIdx === -1) return [];
  const values = extractNumbers(firstRowRest);
  for (let i = startIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '') break; // empty line ends the block
    const tokens = trimmed.split(/\s+/);
    if (!tokens.every((t) => NUM_TOKEN_RE.test(t))) break; // next labelled row
    values.push(...tokens.map(Number).filter(Number.isFinite));
  }
  return values;
}

/**
 * Find the `EIGENVALUES OF COR MATRIX` block and extract the numeric
 * values from the rows below it. Skips the column-index row (all
 * integers) that NONMEM emits between the header and the values.
 * Stops at the first non-numeric line / blank-then-non-numeric.
 */
function readEigenvalues(lines: string[]): number[] {
  const startIdx = lines.findIndex((l) => /EIGENVALUES OF COR MATRIX/.test(l));
  if (startIdx === -1) return [];
  const values: number[] = [];
  let seenValues = false;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '') {
      if (seenValues) break; // blank line after values ends the block
      continue; // blank line before values is fine
    }
    const tokens = trimmed.split(/\s+/);
    if (!tokens.every((t) => NUM_TOKEN_RE.test(t))) break; // next section
    // Column-index row: all positive integers, no decimal/exponent.
    const allInts = tokens.every((t) => /^\d+$/.test(t));
    if (allInts && !seenValues) continue; // header column indices
    if (allInts) break; // unexpected; stop rather than mix
    values.push(...tokens.map(Number).filter(Number.isFinite));
    seenValues = true;
  }
  return values;
}

function extractNumbers(text: string): number[] {
  const out: number[] = [];
  for (const tok of text.trim().split(/\s+/)) {
    if (!NUM_TOKEN_RE.test(tok)) continue;
    const n = Number(tok);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}
