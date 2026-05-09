// Helper: locate `.ext` for a given `.lst` and parse it for the
// per-iteration trajectory used by the inspector's convergence-plot
// section. Mirrors `load-ext-fit.ts`'s shape — same find+read+parse
// pipeline, different parser at the end.
//
// Two disk reads when both fit + trajectory load (cheap; .ext is
// typically <100 KB) — kept separate so each loader remains
// independently swappable.

import { NOOP_LOGGER, type Logger } from '../log-utils';
import { readExtText } from './load-ext-text';
import { parseExtTrajectory, type ExtTrajectory } from './parse-ext-trajectory';

/**
 * Locate the `.ext` for an `.lst`, read it, parse trajectories.
 * Returns an empty array on any failure (mirrors `loadExtFitForLst`'s
 * "degrade to null/empty" pattern); inspector hides the section when
 * there's nothing to plot.
 */
export async function loadExtTrajectoryForLst(
  lstPath: string,
  log: Logger = NOOP_LOGGER,
): Promise<ExtTrajectory[]> {
  const text = await readExtText(lstPath, log);
  return text === null ? [] : parseExtTrajectory(text);
}
