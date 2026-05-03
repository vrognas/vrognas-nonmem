import type * as positron from 'positron';
import type { HostProfile } from '../host-profiles';

// We deliberately import Positron *types* but the actual enum values must
// come from the runtime API at call time (PositronApi.LanguageRuntimeStartupBehavior).
// The metadata factory therefore takes the API as a parameter.

// Inline NONMEM runtime icon — bold "NM" monogram on a teal rounded square.
// Distinguishes the entry from positron-r (blue) and positron-python (yellow/blue)
// in the runtime-picker. Encoded once at module load.
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
}

/**
 * Construct LanguageRuntimeMetadata for a given host profile.
 *
 * `runtimeId` is deterministic per alias so that Positron's session
 * restoration recognises the same runtime across IDE restarts. We don't
 * use a UUID; a stable string keyed on alias is sufficient and avoids
 * having to persist GUIDs.
 */
export function buildRuntimeMetadata(
  profile: HostProfile,
  deps: BuildMetadataDeps,
): positron.LanguageRuntimeMetadata {
  return {
    runtimePath: `ssh://${profile.alias}`, // pseudo-path; never resolved as a real path
    runtimeId: `positron-nonmem-${profile.alias}`,
    runtimeName: `NONMEM (${profile.alias})`,
    runtimeShortName: profile.alias,
    runtimeVersion: '0.0.1', // extension version; bump with package.json
    runtimeSource: 'SSH',
    languageName: 'NMTRAN',
    languageId: 'nmtran',
    languageVersion: '7.6.0', // NONMEM version; cosmetic until M2+ probes the host
    base64EncodedIconSvg: NONMEM_ICON_BASE64,
    startupBehavior: deps.startupBehavior,
    sessionLocation: deps.sessionLocation,
    extraRuntimeData: { hostAlias: profile.alias },
  };
}
