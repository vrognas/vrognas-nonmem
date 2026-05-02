import type * as positron from 'positron';
import type { HostProfile } from '../host-profiles';

// We deliberately import Positron *types* but the actual enum values must
// come from the runtime API at call time (PositronApi.LanguageRuntimeStartupBehavior).
// The metadata factory therefore takes the API as a parameter.

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
    base64EncodedIconSvg: undefined,
    startupBehavior: deps.startupBehavior,
    sessionLocation: deps.sessionLocation,
    extraRuntimeData: { hostAlias: profile.alias },
  };
}
