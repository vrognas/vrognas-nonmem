// Single source of truth for identifiers shared between source, tests, and
// (manually kept in sync) package.json. Update here first; mirror in
// package.json's `contributes` only when adding/renaming a command or
// config section.

export const EXTENSION_ID = 'vrognas.positron-nonmem';

export const OUTPUT_CHANNEL_NAME = 'Positron NONMEM';

export const COMMAND = {
  runModel: 'positronNonmem.runModel',
  showNmtranParsedModel: 'positronNonmem.showNmtranParsedModel',
  refreshRuns: 'positronNonmem.refreshRuns',
} as const;

/** Settings keys (paired with `contributes.configuration` in package.json). */
export const SETTING = {
  nmfeBinary: 'positronNonmem.nmfeBinary',
} as const;

/** Tree-view ID used in package.json `contributes.views`. */
export const VIEW_ID = {
  runs: 'positronNonmem.runs',
} as const;

/** Default nmfe76 binary path; overridable via `positronNonmem.nmfeBinary`. */
export const DEFAULT_NMFE_BINARY = 'nmfe76';
