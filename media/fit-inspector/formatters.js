// formatters.js — pure value→DOM/string formatters for the Fit
// Inspector. All read the `thresholds` global (set by `client.js` on
// each `render()`) and emit either a string or a `<span>` with the
// `.bad` / `.warn` class. Loaded BEFORE `client.js` via the inspector
// HTML; functions are declared at top level so they're plain globals
// (no module loaders, no CSP gymnastics — same model as `client.js`).
//
// Threshold sources (workspace settings, see `package.json`'s
// `nonmem.*` entries) flow extension → payload → `thresholds` global:
//   shrinkageWarnPct  (default 30, pharmacometrics convention)
//   rseWarnPct        (default 100; RSE ≥ |estimate| → unidentified)
//   rseThetaWarnPct   (default 30,  THETA orange threshold)
//   rseOmegaWarnPct   (default 50,  OMEGA / SIGMA orange threshold — random-effect RSEs run higher)
//   pValWarnThreshold (default 0.1)
//   pValBadThreshold  (default 0.05)
//   nsigRequired      (.lst-derived `$EST NSIG=` value; null = no highlight)

/**
 * General-purpose number renderer used everywhere a value lands in
 * the inspector. Behaviour:
 *   - non-finite             → `String(v)` (surfaces `NaN` instead of silent em-dash)
 *   - |v| ≥ 10000 or |v| < 1e-3 → scientific via `fmtScientific`
 *     (always rounded to 0 mantissa decimals — `1.807e+35` → `"2e+35"`,
 *     `437005.037` → `"4e+05"`, `1000000` → `"1e+06"`, `0.0002` →
 *     `"2e-04"`. Exponent is zero-padded to 2 digits to match NONMEM
 *     convention and the hardcoded `1e+06` sentinel display.)
 *   - else                   → exactly 3 decimals via `toFixed(3)`,
 *     trailing zeros preserved (`1` → `"1.000"`, `1.5` → `"1.500"`,
 *     `242.706` unchanged). Uniform decimal width means the fraction
 *     span (`min-width: 4ch`) is always exactly 4ch and the `.` /
 *     `e` decimal anchor sits at the same X across every row.
 *
 * Full unrounded value lives in the cell's `title` attribute — rowEl
 * sets `td.title = String(v)` for number cells, so hover reveals
 * `1.807e+35` even when display shows `2e+35`.
 */
function fmtNum(v) {
  if (typeof v !== 'number' || !isFinite(v)) return String(v);
  if (v === 0) return '0.000';
  const abs = Math.abs(v);
  if (abs >= 10000 || abs < 1e-3) return fmtScientific(v);
  return v.toFixed(3);
}

/**
 * `toExponential(0)` with the exponent zero-padded to ≥2 digits.
 * `(1e6).toExponential(0)` returns `"1e+6"` (1-digit exp); we want
 * `"1e+06"` for consistency with NONMEM's emit format and with the
 * `impliedBoundCell` sentinel constants. Three-or-more-digit exponents
 * (e.g. `e+262`) pass through unchanged.
 */
function fmtScientific(v) {
  const raw = v.toExponential(0);          // e.g. "1e+6" / "2e-4" / "2e+262"
  const eIdx = raw.indexOf('e');
  const mantissa = raw.slice(0, eIdx);
  const expStr = raw.slice(eIdx + 1);      // "+6", "-4", "+262"
  const sign = expStr[0];
  const digits = expStr.slice(1).padStart(2, '0');
  return mantissa + 'e' + sign + digits;
}

/**
 * XML estimation_options value renderer. NONMEM emits attribute values
 * verbatim from internal storage which trails noise zeros and uses
 * scientific even for numbers comfortable in fixed form:
 *   `1000000.00000000`        → `1000000`
 *   `0.400000000000000`       → `0.4`
 *   `5.000000000000000E-02`   → `0.05`
 *   `1.000000000000000E-06`   → `1E-06`
 *   `BLANK` / `no` / `pop`    → returned as-is (string identifiers)
 *
 * Keep precision: any value too small / too large for fixed notation
 * (|x| < 0.001 or ≥ 1e7) renders in JS-canonical scientific (no
 * trailing-zero mantissa) with the NONMEM-style `E[+-]NN` exponent
 * (sign + 2-digit min). Otherwise JS `Number.toString` is the natural
 * "minimum-digits" representation.
 */
function fmtXmlOptionValue(s) {
  if (typeof s !== 'string' || s === '') return s;
  const n = Number(s);
  if (Number.isFinite(n)) {
    if (n === 0) return '0';
    const abs = Math.abs(n);
    if (abs >= 0.001 && abs < 1e7) {
      return n.toString();                  // strips trailing zeros naturally
    }
    // Scientific: strip mantissa trailing zeros, format exponent as `E[+-]NN`.
    const expStr = n.toExponential();       // e.g. `1e-6`, `1.5e+10`
    const eIdx = expStr.indexOf('e');
    let mantissa = expStr.slice(0, eIdx);
    const exp = Number(expStr.slice(eIdx + 1));
    if (mantissa.indexOf('.') !== -1) {
      mantissa = mantissa.replace(/\.?0+$/, '');
    }
    const expSign = exp >= 0 ? '+' : '-';
    const expAbs = Math.abs(exp).toString().padStart(2, '0');
    return mantissa + 'E' + expSign + expAbs;
  }
  // Non-numeric string. NONMEM emits NM-TRAN keyword values lowercase
  // in the XML (`saem`, `pop`, `s1pe12.5`, `tsol`, `noslow`) — display
  // uppercase to match the NM-TRAN code convention (`METHOD=SAEM`,
  // `FORMAT=S1PE12.5`). Exception: filename-like values (`psn.ext`,
  // `psn.lst`, dataset paths) keep their case so the user can grep
  // for them on disk verbatim.
  if (/\.[a-z]{2,6}$/i.test(s)) return s;   // looks like a file extension
  return s.toUpperCase();
}

/**
 * RSE rendered as a percentage with 2 decimals (`6.66%`). Two-tier
 * coloring:
 *   - `> rseWarnPct`              → `.bad` (red, ~unidentified)
 *   - `> rseThetaWarnPct` (theta) /
 *     `rseOmegaWarnPct` (omega/sigma) → `.warn` (orange)
 * Below those, plain text.
 */
function fmtRse(v, kind) {
  if (typeof v !== 'number' || !isFinite(v)) return null;
  const pct = v * 100;
  const text = pct.toFixed(2) + '%';
  // `>=` rather than `>` so a value exactly at the threshold is flagged.
  // Pharmacometric convention treats threshold values as already in-tier.
  if (pct >= thresholds.rseWarnPct) return badge(text, 'bad');
  const warnAt = kind === 'theta' ? thresholds.rseThetaWarnPct : thresholds.rseOmegaWarnPct;
  if (pct >= warnAt) return badge(text, 'warn');
  return text;
}

/**
 * P-value rendered to 3 decimals. Tiered:
 *   - `< pValBadThreshold`  → `.bad` (red, significant departure)
 *   - `< pValWarnThreshold` → `.warn` (orange, borderline)
 */
function fmtPVal(v) {
  if (typeof v !== 'number' || !isFinite(v)) return null;
  const text = v.toFixed(3);
  if (v < thresholds.pValBadThreshold) return badge(text, 'bad');
  if (v < thresholds.pValWarnThreshold) return badge(text, 'warn');
  return text;
}

/**
 * Shrinkage formatted as `XX.XX%`. Two tiers:
 *   - `.bad`  (red)   : `v >= thresholds.shrinkageWarnPct` (default 30,
 *                       pharmacometrics red-flag). Configurable via
 *                       `nonmem.shrinkageWarnPct`.
 *   - `.warn` (yellow): `v >= thresholds.shrinkageBorderlineWarnPct`
 *                       (default 20) AND below the bad threshold —
 *                       borderline shrinkage. Configurable via
 *                       `nonmem.shrinkageBorderlineWarnPct`.
 */
function fmtShrinkage(v) {
  if (typeof v !== 'number' || !isFinite(v)) return null;
  const text = v.toFixed(2) + '%';
  // `>=` to mirror p-value's `<` semantics: threshold-value is in-tier.
  if (v >= thresholds.shrinkageWarnPct) return badge(text, 'bad');
  if (v >= thresholds.shrinkageBorderlineWarnPct) return badge(text, 'warn');
  return text;
}

/**
 * Per-parameter NUMSIGDIG cell. Always one fixed decimal so values
 * like `8.0` don't collapse to `8` (would sit oddly next to `9.2`).
 * Below `thresholds.nsigRequired` (the user's `$EST NSIG=` target)
 * → `.bad`. Pre-formatted string return preempts rowEl's `fmtNum`
 * which would strip the trailing zero.
 */
function fmtNsd(v) {
  if (typeof v !== 'number' || !isFinite(v)) return null;
  const target = thresholds.nsigRequired;
  const text = v.toFixed(1);
  if (typeof target === 'number' && v < target) return badge(text, 'bad');
  return text;
}

/** Build a `<span class="…">text</span>`. Reused by RSE / shrinkage / NSD threshold colouring. */
function badge(text, className) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

/**
 * XML `<nm:termination_status>` → human-readable label. The semantics
 * differ by method per nmguides (§3.11 root.xml, NM73+):
 *
 *   EM/MCMC methods (IMP, IMPMAP, SAEM, ITS, DIRECT, BAYES, NUTS):
 *     0, 8   → optimization completed
 *     1, 9   → not completed (ran out of iterations)
 *     2, 10  → not tested for convergence
 *     3, 11  → not tested for convergence + user interrupted
 *     4, 12  → not completed + user interrupted
 *     16, 24 → OBJF infinite or all individual OBJFs zero (problem ended)
 *     32, 40 → all individual OBJFs zero (problem ended)
 *     The high-bit codes (8/9/10/11/12/24/40) additionally signal that
 *     the reduced stochastic/stationary portion was not completed prior
 *     to user interrupt.
 *
 *   Classical methods (FOCE/FOCEI/FO/LAPLACE):
 *     The status is an arbitrary FORTRAN error number (e.g. 132, 134).
 *     Bauer doesn't document a stable mapping; codes index into
 *     `textmsgs.f90` (use `textmsgsCodeLabel` for known values).
 *     Negative values indicate user-interrupt.
 *
 * `methodKind` discriminates: 'em' for EM/MCMC, 'classical' for the
 * deterministic family. Pass null when method is unknown — the
 * function falls back to a bare-code rendering.
 */
function terminationCodeLabel(c, methodKind) {
  if (methodKind === 'em') {
    switch (c) {
      case 0:
      case 8:
        return 'completed';
      case 1:
      case 9:
        return 'ran out of iterations';
      case 2:
      case 10:
        return 'not tested for convergence';
      case 3:
      case 11:
        return 'not tested + user interrupted';
      case 4:
      case 12:
        return 'not completed + user interrupted';
      case 16:
      case 24:
        return 'OBJF infinite (problem ended)';
      case 32:
      case 40:
        return 'all individual OBJFs zero (problem ended)';
      default:
        return 'code ' + c;
    }
  }
  if (methodKind === 'classical') {
    if (c < 0) return 'user interrupted (code ' + c + ')';
    // FORTRAN error codes — try the textmsgs.f90 mapping.
    const label = textmsgsCodeLabel(c);
    return label ? c + ' (' + label + ')' : 'code ' + c;
  }
  // Unknown method — render the code as-is. The caller usually has
  // method context but defensive when it's missing.
  return 'code ' + c;
}

/**
 * `.ext -1000000007` row codes — empirically-probed mapping against
 * `/opt/nm760/source/TEXTMSGS.f90` on the NM 7.6.0 host. The row contains:
 *   - first non-zero: typically the FORTRAN-runtime (ERROR=N) value
 *     embedded in the chosen TEXT(I) message — e.g. 133/134/136/138 for
 *     rounding-error / infinite-OBJF variants
 *   - subsequent non-zero: indices into NONMEM's `TEXT(I)` message table,
 *     composing the verbatim termination phrase shown by `terminationReason`
 * Only codes confirmed by reading TEXTMSGS.f90 lines 130-200 are mapped;
 * unknowns return null and the inspector renders the bare integer.
 */
function textmsgsCodeLabel(c) {
  switch (c) {
    // FORTRAN-runtime (ERROR=N) codes embedded in the message text:
    case 133: return 'rounding (ERROR=133)';
    case 134: return 'rounding (ERROR=134)';
    case 136: return 'infinite OBJF proximity (ERROR=136)';
    case 138: return 'infinite OBJF proximity (ERROR=138)';
    // TEXT(I) message-table indices — short labels for the most common.
    // The verbatim long phrase is in `terminationReason` already; these
    // are just terse identifiers for code-trail readability.
    case 36: return 'MINIMIZATION SUCCESSFUL';
    case 38: return 'problems with minimization';
    case 39: return 'no. sig. digits unreportable';
    case 40: return 'parameter near boundary';
    case 50: return 'MINIMIZATION TERMINATED';
    case 51: return 'max evaluations exceeded';
    case 52: return 'zero gradient';
    case 53: return 'rounding errors';
    case 54: return 'rounding errors';
    case 55: return 'infinite OBJF at initial';
    case 60: return 'OMEGA singular';
    default: return null;
  }
}
