// Privacy scrubber for PsN / NONMEM stdout / stderr.
//
// NONMEM prints lines like:
//   Manager Location <hostname>//home/<user-email>/<path>/...
//   License Registered to: <organization>
// These leak user emails, organization names, and the host's true name
// (we want to show the SSH alias, not the resolved hostname).
//
// PsN's own logs add user-shaped paths (typically the workspace root
// under /home/<user>/...). We don't want those bleeding into the
// Output channel, the Console pane, or any future telemetry / log
// upload.
//
// Patterns target the canonical PsN/NONMEM markers verified empirically
// in `docs/psn-notes.md` ("Privacy hazard in NONMEM stdout"). They are
// deliberately conservative — we redact the values, not the surrounding
// context, so a debugger can still tell what kind of line was scrubbed.

const REDACTIONS: Array<{ pattern: RegExp; replacement: string }> = [
  // Manager Location <hostname>//home/<user>/...  → marker preserved, value gone.
  { pattern: /^(\s*Manager Location)\s+\S.*$/gm, replacement: '$1 <redacted>' },
  // Manager Hostname=<hostname>  → marker preserved, value gone. Distinct
  // from `Manager Location` — NM 7.6.0 SSH-forwarded manager emits both.
  { pattern: /^(\s*Manager Hostname\s*=)\s*\S.*$/gm, replacement: '$1<redacted>' },
  // Compiled by <user>@<host> on <date>  → drop everything after the marker.
  // Reveals username + hostname in a single line; not caught by the email
  // rule because `user@host` (no TLD) doesn't look like an email.
  { pattern: /^(\s*Compiled by)\s+\S.*$/gm, replacement: '$1 <redacted>' },
  // Working directory: /home/<user>/...  → drop the path entirely. PsN
  // and NONMEM both echo the absolute cwd at startup.
  { pattern: /(working directory[:\s]+)\S.*$/gim, replacement: '$1<redacted>' },
  // License Registered to: <org>  → marker preserved, value gone.
  { pattern: /^(\s*License Registered to:)\s*.*$/gm, replacement: '$1 <redacted>' },
  // User-named path components: /home/<user>/...  → /home/<user>/...
  // Run BEFORE the email replacement so an email-shaped path component
  // gets path-redacted (yielding `/home/<user>/`) instead of leaving
  // `/home/<redacted-email>/` and then matching the `/home/[^/]+` rule.
  { pattern: /\/home\/[^/\s]+\//g, replacement: '/home/<user>/' },
  // Bare email tokens not already inside a /home/ path.
  { pattern: /[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/g, replacement: '<redacted-email>' },
];

/**
 * Scrub a chunk of PsN/NONMEM output before showing it to the user or
 * forwarding it to telemetry / logs. Idempotent: running a second pass
 * is a no-op on already-scrubbed text.
 */
export function scrubPrivate(text: string): string {
  let out = text;
  for (const { pattern, replacement } of REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
