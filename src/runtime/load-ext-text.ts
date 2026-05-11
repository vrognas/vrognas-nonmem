// Single-source-of-truth helper: locate the `.ext` for an `.lst` and
// read its text. Used by callers that want to run multiple parsers
// over the same file (e.g. the inspector reads both `parseExtFit`
// and `parseExtTrajectory` from one .ext) — paying for the disk
// roundtrip once instead of N times. Per-parser convenience wrappers
// (`loadExtFitForLst` / `loadExtTrajectoryForLst`) still exist for
// callers that only need one parse and don't care about sharing.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { errMsg, NOOP_LOGGER, type Logger } from '../log-utils';
import { findExtFile } from './find-ext-file';

export async function readExtText(
  lstPath: string,
  log: Logger = NOOP_LOGGER,
): Promise<string | null> {
  const extPath = await findExtFile(lstPath);
  if (!extPath) return null;
  try {
    return await fs.readFile(extPath, 'utf8');
  } catch (e) {
    log(`load-ext-text: read failed for ${path.basename(extPath)}: ${errMsg(e)}`);
    return null;
  }
}
