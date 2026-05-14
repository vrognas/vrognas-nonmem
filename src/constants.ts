// Single source of truth for identifiers shared between source, tests, and
// (manually kept in sync) package.json. Update here first; mirror in
// package.json's `contributes` only when adding/renaming a command or
// config section.

export const EXTENSION_ID = 'vrognas.nonmem';

export const OUTPUT_CHANNEL_NAME = 'Positron NONMEM';

export const COMMAND = {
  runModel: 'nonmem.runModel',
  showNmtranParsedModel: 'nonmem.showNmtranParsedModel',
  refreshRuns: 'nonmem.refreshRuns',
  /** Click-handler for an Active Runs entry — dispatches by run state. */
  openRun: 'nonmem.openRun',
  /** Right-click on a `done` Active Runs entry — runs PsN's `update_inits`. */
  promoteEstimates: 'nonmem.promoteEstimates',
  /** Toolbar icon on the Runs view — opens the lineage WebView panel. */
  showLineage: 'nonmem.showLineage',
  /** Right-click on a running Active Runs entry — sends `next.sig` (advance to next $EST mode). */
  signalEndMode: 'nonmem.signalEndMode',
  /** Right-click on a running Active Runs entry — sends `stop.sig` (skip remaining $EST, run $COV, finish). */
  signalStopRun: 'nonmem.signalStopRun',
} as const;

/** Tree-view IDs used in package.json `contributes.views`. */
export const VIEW_ID = {
  runs: 'nonmem.runs',
  activeRuns: 'nonmem.activeRuns',
} as const;

/**
 * PsN's `execute` binary — the toolbelt's nmfe replacement. Always invoked
 * by name (PATH-resolved); chunk B will add a settings override if needed.
 */
export const DEFAULT_EXECUTE_BINARY = 'execute';
