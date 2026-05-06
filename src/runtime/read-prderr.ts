// readPrderr — locate and read NONMEM's `PRDERR` (warnings / numerical
// issues file) for a finished run.
//
// File location depends on PsN's clean level:
//   -clean=3+ : `<modelfitDir>/NM_run1/PRDERR` survives as a plain file.
//   -clean<=2 : NM_run1/ is archived to `<modelfitDir>/NM_run1.7z`.
// Per docs/psn-notes.md "Clean-level effects" (verified 2026-05-04).
//
// We try the plain file first (cheapest path). On miss, we fall back to
// extracting from the .7z via `7z e -so` through the injected Runner.
// When neither path produces content (no PRDERR was emitted = clean run
// without warnings), return null and the caller hides the block.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathExists } from '../fs-utils';
import type { Runner } from '../runner';
import { quote } from '../shell';

export interface ReadPrderrOptions {
  /** Absolute path to the run's `modelfit_dir<N>`. */
  modelfitDir: string;
  /** Runner used for archive extraction. Plain-file path doesn't need one. */
  runner?: Runner;
}

export interface PrderrContent {
  content: string;
  /** Where the content came from — useful when surfacing in the UI. */
  source: 'plain' | 'archive';
}

const ARCHIVE_NAME = 'NM_run1.7z';

export async function readPrderr(opts: ReadPrderrOptions): Promise<PrderrContent | null> {
  const plainPath = path.join(opts.modelfitDir, 'NM_run1', 'PRDERR');
  if (await pathExists(plainPath)) {
    try {
      const content = await fs.readFile(plainPath, 'utf8');
      if (content.trim() === '') return null;
      return { content, source: 'plain' };
    } catch {
      // fall through to archive — race between exists() and read.
    }
  }

  const archivePath = path.join(opts.modelfitDir, ARCHIVE_NAME);
  if (!opts.runner || !(await pathExists(archivePath))) return null;

  // 7z e -so: extract to stdout. Member name `PRDERR` matches the
  // canonical NONMEM file name inside NM_run1.7z. -y answers "yes"
  // to any prompts (e.g. overwrite). 2>/dev/null mutes 7z's chatty
  // banner so we don't conflate it with file contents.
  const cmd = `7z e -so -y ${quote(archivePath)} PRDERR 2>/dev/null`;
  try {
    const result = await opts.runner.run(cmd, opts.modelfitDir);
    if (result.code !== 0) return null;
    const content = result.stdout;
    if (content.trim() === '') return null;
    return { content, source: 'archive' };
  } catch {
    return null;
  }
}
