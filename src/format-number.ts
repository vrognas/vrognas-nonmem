// Compact number formatter used across all server-side modules
// (variables comm, hover, lst-decoration, …) and conceptually
// mirrored in the WebView client.js's `fmtNum` (same policy):
//
//   - 0 → '0'
//   - |v| ≥ 1e7 or 0 < |v| < 1e-3 → toExponential(3)
//   - everything else → fixed-3 decimals, trailing zeros dropped

/** Render a number for compact UI display. Pass-through for non-finite. */
export function formatNumberCompact(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e7 || abs < 1e-3) return n.toExponential(3);
  return parseFloat(n.toFixed(3)).toString();
}
