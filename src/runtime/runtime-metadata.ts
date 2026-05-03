import type * as positron from 'positron';

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
  /** NONMEM version string; M5+ probe the host for this. */
  nonmemVersion: string;
}

/**
 * Construct LanguageRuntimeMetadata for the local NONMEM install.
 *
 * `runtimeId` is a stable string so Positron's session restoration
 * recognises the same runtime across IDE restarts (no UUIDs persisted).
 */
export function buildRuntimeMetadata(
  deps: BuildMetadataDeps,
): positron.LanguageRuntimeMetadata {
  return {
    runtimePath: 'nmfe76', // pseudo-path; never resolved as a real path
    runtimeId: 'positron-nonmem',
    runtimeName: `NONMEM ${deps.nonmemVersion}`,
    runtimeShortName: 'NONMEM',
    runtimeVersion: '0.0.1',
    runtimeSource: 'NONMEM',
    languageName: 'NMTRAN',
    languageId: 'nmtran',
    languageVersion: deps.nonmemVersion,
    base64EncodedIconSvg: NONMEM_ICON_BASE64,
    startupBehavior: deps.startupBehavior,
    sessionLocation: deps.sessionLocation,
    extraRuntimeData: {},
  };
}
