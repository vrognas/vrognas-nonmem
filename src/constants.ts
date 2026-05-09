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
  /** Click-handler for an Active Runs entry — dispatches by run state. */
  openRun: 'positronNonmem.openRun',
  /** Right-click on a `done` Active Runs entry — runs PsN's `update_inits`. */
  promoteEstimates: 'positronNonmem.promoteEstimates',
  /** Toolbar icon on the Runs view — opens the lineage WebView panel. */
  showLineage: 'positronNonmem.showLineage',
  /** Right-click on a running Active Runs entry — sends `next.sig` (advance to next $EST mode). */
  signalEndMode: 'positronNonmem.signalEndMode',
  /** Right-click on a running Active Runs entry — sends `stop.sig` (skip remaining $EST, run $COV, finish). */
  signalStopRun: 'positronNonmem.signalStopRun',
} as const;

/** Tree-view IDs used in package.json `contributes.views`. */
export const VIEW_ID = {
  runs: 'positronNonmem.runs',
  activeRuns: 'positronNonmem.activeRuns',
} as const;

/**
 * PsN's `execute` binary — the toolbelt's nmfe replacement. Always invoked
 * by name (PATH-resolved); chunk B will add a settings override if needed.
 */
export const DEFAULT_EXECUTE_BINARY = 'execute';
