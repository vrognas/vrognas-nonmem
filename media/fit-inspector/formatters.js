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
 *   - non-finite       → `String(v)` (mostly to surface `NaN` instead of silent em-dash)
 *   - 0                → `"0"`
 *   - |v| ≥ 1e7 or < 1e-3 → exponential with 3 significant digits
 *   - else              → up to 3 decimals, trailing zeros stripped
 *     (so `0.500` → `"0.5"`, `1.234` → `"1.234"`, `1` → `"1"`)
 */
function fmtNum(v) {
  if (typeof v !== 'number' || !isFinite(v)) return String(v);
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1e7 || abs < 1e-3) return v.toExponential(3);
  return parseFloat(v.toFixed(3)).toString();
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
  if (pct > thresholds.rseWarnPct) return badge(text, 'bad');
  const warnAt = kind === 'theta' ? thresholds.rseThetaWarnPct : thresholds.rseOmegaWarnPct;
  if (pct > warnAt) return badge(text, 'warn');
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
 * Shrinkage formatted as `XX.XX%`. Above `thresholds.shrinkageWarnPct`
 * (configurable; default 30) gets `.bad`, otherwise plain text.
 */
function fmtShrinkage(v) {
  if (typeof v !== 'number' || !isFinite(v)) return null;
  const text = v.toFixed(2) + '%';
  return v > thresholds.shrinkageWarnPct ? badge(text, 'bad') : text;
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
 * XML `<nm:termination_status>` mapping — single status code per $EST step.
 * 0..5 are the documented termination statuses (Bauer NM7 manual). Higher
 * values originate from the FORTRAN runtime (textmsgs.f90 ERROR=N codes)
 * and don't have a clean status label, so we fall back to a bare code.
 */
function terminationCodeLabel(c) {
  switch (c) {
    case 0:
      return 'success';
    case 1:
      return 'rounding';
    case 2:
      return 'max evals';
    case 3:
      return 'near boundary';
    case 4:
      return 'NaN/overflow';
    case 5:
      return 'user interrupt';
    default:
      return 'code ' + c;
  }
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
