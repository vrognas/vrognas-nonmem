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
} as const;

export const HOST_DEFAULTS = {
  alias: 'primary',
  transport: 'auto',
} as const;

/** Where remote runs land on the host. Subdir-per-run discipline lives below this. */
export const REMOTE_RUN_ROOT = '~/positron-nonmem';

/** Workspace-relative root for everything this extension persists locally. */
const LOCAL_ROOT = '.positron-nonmem';

/** Workspace-relative dir for the local mirror of run outputs. */
export const LOCAL_RUNS_SUBDIR = `${LOCAL_ROOT}/runs`;

/** Workspace-relative path of the append-only audit log (one line per run). */
export const LOCAL_AUDIT_FILE = `${LOCAL_ROOT}/audit.jsonl`;

/** Path to nmfe76 on the host (NONMEM 7.6.0). Hard-coded for chunk 3A; settings-driven post-3D. */
export const NMFE_BINARY = '/opt/nm760/run/nmfe76';

/** NONMEM version string recorded in manifest.json; matches runtime-metadata. */
export const NONMEM_VERSION = '7.6.0';
