// Slice the embedded NM-TRAN control stream out of a `.lst`. NONMEM
// (and PsN's `execute`) write the verbatim control stream at the top
// of the .lst, terminating at one of two sentinel lines:
//
//   - `NM-TRAN MESSAGES`  — added by the NM-TRAN preprocessor every
//     run. Reliable for runs that compiled.
//   - `1NONLINEAR MIXED EFFECTS MODEL PROGRAM`  — NONMEM's banner
//     line, present in every successful execution.
//
// Returns the slice from the first `$PROBLEM` (or `$PROB`) line up to
// (but not including) the first sentinel found. Null when no
// `$PROBLEM` line exists (file isn't an NM-TRAN .lst).
//
// Why this is load-bearing: the Fit Inspector in lst-mode used to
// derive parameter labels (and any other parsed-model fact) from the
// sibling `.mod`. That .mod changes as the modeler iterates AFTER the
// run completes, which leaked forward into the inspector view of past
// runs. Reading the embedded control stream pins the inspector to
// what was actually run.

const PROBLEM_RE = /^\s*\$PROB(LEM)?\b/i;

const TERMINATORS: RegExp[] = [
  /^\s*NM-TRAN MESSAGES\s*$/i,
  /^\s*1NONLINEAR MIXED EFFECTS MODEL PROGRAM\b/i,
  /^\s*License Registered to:/i,
];

/**
 * Defensive cap on the slice length. Real NMTRAN control streams are
 * typically <300 lines; capping at 2000 lines protects against a
 * malformed .lst where the terminator never appears (NONMEM crashed
 * mid-write, file got truncated to a different boundary, …) — without
 * the cap we'd hand the parser potentially tens of thousands of FORTRAN-
 * output lines, which is slow and surfaces nonsense in the inspector.
 */
const MAX_CTRL_STREAM_LINES = 2000;

/**
 * Extract the embedded NM-TRAN control stream from `.lst` text.
 * Returns null when no `$PROBLEM` opener is found, or when no
 * terminator sentinel was reached within `MAX_CTRL_STREAM_LINES` (the
 * .lst is truncated / corrupted; safer to render no inspector than a
 * misleading partial one).
 */
export function extractControlStream(lstText: string): string | null {
  const lines = lstText.split(/\r?\n/);
  const start = lines.findIndex((l) => PROBLEM_RE.test(l));
  if (start === -1) return null;
  const hardEnd = Math.min(lines.length, start + MAX_CTRL_STREAM_LINES);
  let end: number | null = null;
  for (let i = start + 1; i < hardEnd; i++) {
    if (TERMINATORS.some((re) => re.test(lines[i]))) {
      end = i;
      break;
    }
  }
  if (end === null) return null;
  return lines.slice(start, end).join('\n').trimEnd();
}
