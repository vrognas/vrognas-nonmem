// Pure parser for PsN's `sumo` (Summary of Output from NONMEM) plain-
// text output. Verified empirically against PsN 5.3.1 + NONMEM 7.6.0
// — see docs/psn-notes.md "sumo" section.
//
// Sumo's output is roughly:
//
//   -----------------------------------------------------------------
//   m.lst
//
//   <Status label>                                            [  OK   ]
//   <Status label>                                            [WARNING]
//   <Status label>                                            [ ERROR ]
//   Condition number                                          [  OK   ]   ← status row
//   <Free-form info line>.
//
//   Total run time for model (hours:min:sec):           0:00:01
//   Estimation time for subproblem, sum over $EST (seconds):   0.12
//   Objective function value: 4.5310
//   Condition number: 420.3                                              ← value row (colon!)
//   Number of observation records: 4
//   Number of individuals: 2
//
//   <parameter table>
//   -----------------------------------------------------------------
//
// Note: `Condition number` appears TWICE when $COV ran cleanly — once
// as a STATUS row (`Condition number  [  OK  ]`) and once as a VALUE row
// (`Condition number: 420.3`). The colon distinguishes them. Verified
// empirically 2026-05-03 against PsN 5.3.1 — see test fixture in
// `test/runtime/parse-sumo.test.ts` `it('parses condition number...`).
//
// The status block has a fixed shape: `<label>  [  <level>  ]` where
// `<level>` is one of OK / WARNING / ERROR. Free-form info lines (no
// brackets, e.g. `No covariance step run.`) are skipped. Anything not
// recognised is ignored — we don't fail on extra text.

export type SumoLevel = 'OK' | 'WARNING' | 'ERROR';

export interface SumoStatus {
  label: string;
  level: SumoLevel;
  /**
   * Indented detail lines following the status row in sumo's output
   * (e.g. parameter pairs + correlation values listed under
   * `Large correlations between parameter estimates found
   * [WARNING]`). Empty when the status had no detail block.
   */
  detail: string[];
}

export interface SumoSummary {
  statuses: SumoStatus[];
  /** Objective Function Value (final). Null when sumo didn't emit it. */
  ofv: number | null;
  /** `0:00:01`-shaped HH:MM:SS string. */
  totalRuntime: string | null;
  /** Estimation time across all $EST steps, seconds. */
  estimationSeconds: number | null;
  observations: number | null;
  individuals: number | null;
  /** Set when $COV ran successfully. */
  conditionNumber: number | null;
}

const STATUS_RE = /^(.+?)\s+\[\s*(OK|WARNING|ERROR)\s*\]\s*$/;
const OFV_RE = /^Objective function value:\s+(-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)\s*$/;
// Greedy `.*:` consumes the parenthesised inner colons (`(hours:min:sec)`).
const RUNTIME_RE = /^Total run time for model.*:\s+(\S+)\s*$/;
const ESTTIME_RE = /^Estimation time for subproblem.*:\s+([\d.]+)\s*$/;
const OBS_RE = /^Number of observation records:\s+(\d+)\s*$/;
const IND_RE = /^Number of individuals:\s+(\d+)\s*$/;
// Verified empirically: sumo emits `Condition number: 420.3` (colon
// + decimal) when $COV ran successfully. There's also a status row
// (`Condition number   [   OK   ]`) — that one matches STATUS_RE and
// is captured separately. The colon distinguishes value from status.
const COND_RE = /^Condition number:\s+(-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)\s*$/;

/**
 * Parse a sumo stdout dump into a structured summary. Returns null
 * when the text contains nothing we recognise (saves the caller from
 * branching on every individual field).
 */
export function parseSumo(text: string): SumoSummary | null {
  const summary: SumoSummary = {
    statuses: [],
    ofv: null,
    totalRuntime: null,
    estimationSeconds: null,
    observations: null,
    individuals: null,
    conditionNumber: null,
  };

  // Tracks the most recently pushed status so subsequent indented
  // (non-status, non-key:value) lines are appended as its detail.
  // Reset to null on blank lines / next status / recognised key:value.
  let detailTarget: SumoStatus | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      detailTarget = null;
      continue;
    }
    const status = line.match(STATUS_RE);
    if (status) {
      const entry: SumoStatus = {
        label: status[1].trim(),
        level: status[2] as SumoLevel,
        detail: [],
      };
      summary.statuses.push(entry);
      detailTarget = entry;
      continue;
    }
    // Indented continuation: belongs to the previous status as detail.
    // We use the raw line's leading whitespace as the signal — sumo's
    // detail rows are clearly indented under the status label.
    if (detailTarget && /^\s+\S/.test(rawLine)) {
      detailTarget.detail.push(line);
      continue;
    }
    detailTarget = null;
    // Skip already-set fields rather than re-matching their regex on
    // every line. The previous `??=` chain ran every regex against
    // every line, even after a field was set — measurable cost on
    // multi-thousand-line sumo dumps. Per-line we still try every
    // unset field's regex (`if`, not `else if`) since each line might
    // match a different field, but we avoid the redundant work once
    // a field has its value.
    if (summary.ofv === null) summary.ofv = matchNumber(line, OFV_RE);
    if (summary.totalRuntime === null) summary.totalRuntime = matchString(line, RUNTIME_RE);
    if (summary.estimationSeconds === null) summary.estimationSeconds = matchNumber(line, ESTTIME_RE);
    if (summary.observations === null) summary.observations = matchInt(line, OBS_RE);
    if (summary.individuals === null) summary.individuals = matchInt(line, IND_RE);
    if (summary.conditionNumber === null) summary.conditionNumber = matchNumber(line, COND_RE);
  }

  // Empty parse → caller's "garbage" signal.
  if (
    summary.statuses.length === 0 &&
    summary.ofv === null &&
    summary.totalRuntime === null &&
    summary.observations === null &&
    summary.individuals === null
  ) {
    return null;
  }
  return summary;
}

function matchNumber(line: string, re: RegExp): number | null {
  const m = line.match(re);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

function matchInt(line: string, re: RegExp): number | null {
  const v = matchNumber(line, re);
  return v !== null && Number.isInteger(v) ? v : null;
}

function matchString(line: string, re: RegExp): string | null {
  const m = line.match(re);
  return m ? m[1] : null;
}
