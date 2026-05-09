// Helper: locate `.ext` for a given `.lst` and parse it. Single source
// of truth for the four-step pipeline (findExt → readFile → parseExt
// → guard) used by both lst-mode (Fit Inspector) and the lineage
// discoverer (which only needs `.ofv`).
//
// Pure runtime (fs only, no vscode imports) so it stays unit-testable.

import { NOOP_LOGGER, type Logger } from '../log-utils';
import { readExtText } from './load-ext-text';
import { parseExtFit, type ExtEstimates } from './parse-ext-fit';

/**
 * Locate the `.ext` for an `.lst` (Pirana flat or PsN modelfit_dir<N>
 * cascade), read it, parse it. Returns null on any of:
 *   - no `.ext` found (no run or PsN-without-`-nm_output`)
 *   - read failed
 *   - `.ext` lacks a `-1000000000` final-estimates row (run aborted)
 *
 * Failures are logged via `log` but never throw — the caller's
 * Promise.all chain stays clean.
 */
export async function loadExtFitForLst(
  lstPath: string,
  log: Logger = NOOP_LOGGER,
): Promise<ExtEstimates | null> {
  const text = await readExtText(lstPath, log);
  return text === null ? null : parseExtFit(text);
}
