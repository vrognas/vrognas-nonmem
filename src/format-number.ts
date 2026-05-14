// Compact number formatter used across all server-side modules
// (variables comm, hover, lst-decoration, …) and mirrored in the
// WebView client.js's `fmtNum` (same policy — keep in sync):
//
//   - 0 → '0'
//   - |v| ≥ 10000 or 0 < |v| < 1e-3 → scientific via `fmtScientific`
//     (toExponential(0), exponent zero-padded to ≥2 digits — `4e+05`,
//     `1e+06`, `2e+35`, `2e-04`). Matches NONMEM's emit format and
//     keeps the column width predictable: max sci form is 6 chars
//     (`-Ne+NN`) for 2-digit exponents.
//   - everything else → up to 3 decimals, trailing zeros stripped
//     (max "normal" value is `9999.999`, 8 chars)

/** Render a number for compact UI display. Pass-through for non-finite. */
export function formatNumberCompact(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 10000 || abs < 1e-3) return fmtScientific(n);
  return parseFloat(n.toFixed(3)).toString();
}

/**
 * `toExponential(0)` with the exponent zero-padded to ≥2 digits.
 * `(1e6).toExponential(0)` returns `"1e+6"`; we want `"1e+06"` for
 * consistency with NONMEM's emit format and the WebView's
 * `impliedBoundCell` sentinel display. Three-digit exponents
 * (`e+262`) pass through unchanged.
 */
function fmtScientific(n: number): string {
  const raw = n.toExponential(0);
  const eIdx = raw.indexOf('e');
  const mantissa = raw.slice(0, eIdx);
  const expStr = raw.slice(eIdx + 1);
  const sign = expStr[0];
  const digits = expStr.slice(1).padStart(2, '0');
  return mantissa + 'e' + sign + digits;
}
