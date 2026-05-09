// readPrderr — NONMEM's `PRDERR` (warnings / numerical issues file).
// Thin wrapper around `readArchivedFile` for the dual-path location
// (plain in `NM_run1/`, fall back to extraction from `NM_run1.7z`).

import { readArchivedFile, type ArchivedFileContent } from './read-archived-file';
import type { Runner } from '../runner';

export interface ReadPrderrOptions {
  /** Absolute path to the run's `modelfit_dir<N>`. */
  modelfitDir: string;
  /** Runner used for archive extraction. Plain-file path doesn't need one. */
  runner?: Runner;
}

export type PrderrContent = ArchivedFileContent;

export async function readPrderr(opts: ReadPrderrOptions): Promise<PrderrContent | null> {
  return readArchivedFile({
    modelfitDir: opts.modelfitDir,
    memberName: 'PRDERR',
    runner: opts.runner,
  });
}
