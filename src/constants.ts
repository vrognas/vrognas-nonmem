// Single source of truth for identifiers shared between source, tests, and
// (manually kept in sync) package.json. Update here first; mirror in
// package.json's `contributes` only when adding/renaming a command or
// config section.

export const EXTENSION_ID = 'vrognas.positron-nonmem';

export const OUTPUT_CHANNEL_NAME = 'Positron NONMEM';

export const CONFIG_HOST_SECTION = 'positronNonmem.host';

export const COMMAND = {
  testConnection: 'positronNonmem.testConnection',
  runModel: 'positronNonmem.runModel',
  showNmtranParsedModel: 'positronNonmem.showNmtranParsedModel',
} as const;

export const HOST_DEFAULTS = {
  alias: 'primary',
  transport: 'auto',
} as const;

/**
 * Where remote runs land on the host. Subdir-per-run discipline lives
 * below this. Outputs (`m.lst`, `m.ext`, `manifest.json`, …) stay
 * remote — the workspace no longer mirrors them locally; the tree view
 * + FileSystemProvider browse them via the transport on demand.
 */
export const REMOTE_RUN_ROOT = '~/positron-nonmem';

/** Path to nmfe76 on the host (NONMEM 7.6.0). Hard-coded for chunk 3A; settings-driven post-3D. */
export const NMFE_BINARY = '/opt/nm760/run/nmfe76';

/** NONMEM version string recorded in manifest.json; matches runtime-metadata. */
export const NONMEM_VERSION = '7.6.0';
