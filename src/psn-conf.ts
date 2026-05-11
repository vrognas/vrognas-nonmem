// PsN config introspection.
//
// PsN 5.3.1 looks for `psn.conf` at:
//   1. ~/psn.conf  (user override)
//   2. <PsN-install>/lib/psn.conf  (bundled default)
// We don't try to find or parse psn.conf ourselves — too many version-
// specific edge cases. Instead we ask Perl to introspect PsN's own
// config: `$PsN::config->{nm_versions}` is a hash where keys are labels
// and values are `<dir>,<version>` strings.
//
// Bootstrapping the right `-I <lib>` path: the installed `psn` script
// hard-codes a `use lib '<lib>';` line as the first non-shebang line
// (setup.pl injects it). We grep that out, then run perl with the
// matching `-I`. This keeps us PsN-version-agnostic without parsing
// psn.conf format ourselves.
//
// Each label becomes a Positron LanguageRuntime; the user picks one in
// the session picker; the picked label flows through to runModel as
// `-nm_version=<label>`.
//
// See docs/psn-notes.md ("psn.conf nm_versions resolution") for the
// authoritative source-level reference.

import type { Runner } from './runner';
import { scrubPrivate } from './scrub';

export interface NmVersionEntry {
  /** psn.conf [nm_versions] key — passed to `execute -nm_version=<label>`. */
  label: string;
  /** NONMEM install root (the parent of `run/`). PsN looks for nmfe<NN> under <installDir>/run/. */
  installDir: string;
  /** Version string from psn.conf, e.g. "7.6", "7.6.0". */
  version: string;
}

/**
 * Bash script that dumps `[nm_versions]` from PsN's psn.conf as one
 * `<label>\t<dir>,<version>` line per entry. Stays self-contained
 * (no env preconditions) so it runs the same under LocalRunner and
 * via Positron Remote SSH.
 */
export const PSN_CONF_DUMP_SCRIPT = `
psn_bin=$(readlink -f "$(command -v psn)") || exit 1
psn_lib=$(grep -oE "^use lib '[^']+" "$psn_bin" | head -1 | sed "s/^use lib '//")
[ -n "$psn_lib" ] || exit 2
perl -I "$psn_lib" -MPsN -e '
  for my $k (sort keys %{$PsN::config->{nm_versions}}) {
    print "$k\\t$PsN::config->{nm_versions}->{$k}\\n";
  }
'
`.trim();

/**
 * Parse the tab-separated `<label>\t<dir>,<version>` output produced
 * by `PSN_CONF_DUMP_SCRIPT`. Pure function; easy to test without a
 * Runner. Skips malformed lines silently — better to surface a partial
 * list than to fail the whole probe on one bad entry.
 *
 * Returns the entries with `default` first (so it shows at the top of
 * Positron's runtime picker), then the rest in alphabetical order.
 */
export function parseNmVersionsOutput(text: string): NmVersionEntry[] {
  const out: NmVersionEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab < 1) continue;
    const label = line.slice(0, tab).trim();
    const rest = line.slice(tab + 1).trim();
    const comma = rest.indexOf(',');
    if (comma < 1) continue;
    const installDir = rest.slice(0, comma).trim();
    const version = rest.slice(comma + 1).trim();
    if (!label || !installDir || !version) continue;
    // PsN's psn.conf format doesn't permit whitespace inside labels —
    // guard before we surface them to the picker / pass through to
    // `execute -nm_version=<label>` and get a confusing error from PsN.
    if (/\s/.test(label)) continue;
    out.push({ label, installDir, version });
  }
  return out.sort(byDefaultThenLabel);
}

function byDefaultThenLabel(a: NmVersionEntry, b: NmVersionEntry): number {
  if (a.label === 'default') return -1;
  if (b.label === 'default') return 1;
  return a.label.localeCompare(b.label);
}

/**
 * Run `PSN_CONF_DUMP_SCRIPT` via the Runner and parse the result.
 * Throws when no `psn` binary is on $PATH or the Perl introspection
 * fails — caller surfaces this as "PsN required" / "PsN install
 * broken". Returns an empty array when PsN is reachable but defines
 * no `[nm_versions]` (atypical install).
 */
export async function fetchNmVersions(runner: Runner): Promise<NmVersionEntry[]> {
  const result = await runner.run(PSN_CONF_DUMP_SCRIPT);
  if (result.code !== 0) {
    // Scrub: Perl/PsN stderr commonly carries `use lib '/home/<user>/...'`
    // and other path-bearing lines.
    const reason = scrubPrivate(result.stderr.trim()) || `exit ${result.code ?? '?'}`;
    throw new Error(`failed to read PsN config: ${reason}`);
  }
  return parseNmVersionsOutput(result.stdout);
}
