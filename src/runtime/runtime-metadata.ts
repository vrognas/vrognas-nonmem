import type * as positron from 'positron';
import * as path from 'node:path';
import type { NmVersionEntry } from '../psn-conf';

const NONMEM_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<rect width="100" height="100" rx="22" fill="#0e7c7b"/>' +
  '<text x="50" y="68" font-family="system-ui, -apple-system, sans-serif" ' +
  'font-size="44" font-weight="bold" fill="#ffffff" text-anchor="middle">NM</text>' +
  '</svg>';
const NONMEM_ICON_BASE64 = Buffer.from(NONMEM_ICON_SVG).toString('base64');

export interface BuildMetadataDeps {
  startupBehavior: positron.LanguageRuntimeStartupBehavior;
  sessionLocation: positron.LanguageRuntimeSessionLocation;
  /** psn.conf [nm_versions] entry — label is the picker key, installDir/version are display info. */
  nmVersion: NmVersionEntry;
}

/**
 * Construct LanguageRuntimeMetadata for one psn.conf [nm_versions]
 * entry. Multiple entries => call this once per label with distinct
 * `nmVersion.label` values; the runtimeId is keyed off the label so
 * each registers as its own runtime in Positron's picker.
 *
 * `extraRuntimeData.nmVersionLabel` is read back by the manager's
 * createSession and flows through to runModel as `-nm_version=<label>`.
 */
export function buildRuntimeMetadata(deps: BuildMetadataDeps): positron.LanguageRuntimeMetadata {
  const { label, version } = deps.nmVersion;
  const idTag = idTagFromLabel(label);
  const nameSuffix = label === 'default' ? '' : ` (${label})`;
  // runtimePath has no operational role under PsN — `psn execute`
  // resolves the binary via the label. We previously interpolated the
  // real `installDir` here, but Positron stores LanguageRuntimeMetadata
  // and may surface it to crash reporters / logs; an `installDir` like
  // `/home/<user>/nm760` would leak the user's home layout. Use a
  // synthetic placeholder anchored on the label instead — keeps the
  // picker's "show path" affordance non-empty without disclosing the
  // host's real layout.
  const runtimePath = path.posix.join(
    '/_psn-managed',
    idTag,
    'run',
    `nmfe${nmfeSuffixFromVersion(version)}`,
  );
  return {
    runtimePath,
    runtimeId: `positron-nonmem-${idTag}`,
    runtimeName: `NONMEM ${version}${nameSuffix}`,
    runtimeShortName: `NONMEM ${version}`,
    runtimeVersion: '0.0.1',
    runtimeSource: 'NONMEM',
    languageName: 'NMTRAN',
    languageId: 'nmtran',
    languageVersion: version,
    base64EncodedIconSvg: NONMEM_ICON_BASE64,
    startupBehavior: deps.startupBehavior,
    sessionLocation: deps.sessionLocation,
    extraRuntimeData: { nmVersionLabel: label },
  };
}

/**
 * Stable, filesystem-safe tag derived from the psn.conf label. Used
 * as the runtimeId suffix so two entries with the same version (e.g.
 * `default=/opt/nm760,7.6` and `nm760=/opt/nm760,7.6`) get distinct
 * runtime IDs and Positron's session-restoration picks the right one.
 */
function idTagFromLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

/**
 * "7.6" → "76", "7.6.0" → "76", "7" → "7" (single-digit fallback).
 * Used only for the displayed runtimePath; PsN itself decides the
 * actual nmfe binary based on the psn.conf entry.
 */
function nmfeSuffixFromVersion(version: string): string {
  const m = /^(\d+)\.(\d+)/.exec(version);
  if (m) return `${m[1]}${m[2]}`;
  const single = /^(\d+)$/.exec(version);
  return single ? single[1] : '';
}
