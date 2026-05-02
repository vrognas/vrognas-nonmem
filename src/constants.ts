// Single source of truth for identifiers shared between source, tests, and
// (manually kept in sync) package.json. Update here first; mirror in
// package.json's `contributes` only when adding/renaming a command or
// config section.

export const EXTENSION_ID = 'vrognas.positron-nonmem';

export const OUTPUT_CHANNEL_NAME = 'Positron NONMEM';

export const CONFIG_HOST_SECTION = 'positronNonmem.host';

export const COMMAND = {
  testConnection: 'positronNonmem.testConnection',
} as const;

export const HOST_DEFAULTS = {
  alias: 'primary',
} as const;
