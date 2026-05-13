// readArchivedFile — locate-and-read for files that live either as a
// plain file under `NM_run1/` (PsN -clean=3+) or inside `NM_run1.7z`
// (PsN -clean<=2). Originally duplicated across read-prderr.ts and
// read-fmsg.ts; consolidated here so adding a new file (e.g. .grd,
// .cnv) is a one-line wrapper instead of another full copy.
//
// File location depends on PsN's clean level:
//   -clean=3+ : `<modelfitDir>/NM_run1/<member>` survives as a plain file.
//   -clean<=2 : NM_run1/ is archived to `<modelfitDir>/NM_run1.7z`.
// Per docs/psn-notes.md "Clean-level effects" (verified 2026-05-04).
//
// We try the plain file first (cheapest path). On miss, we fall back to
// extracting from the .7z via `7z e -so` through the injected Runner.
// Empty / whitespace-only content yields null (caller hides the block).
//
// The `classify` callback lets a caller add file-specific fields to the
// returned object — e.g. FMSG returns `hasErrors: boolean` based on
// substring detection. Without it, only `content` and `source` are returned.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathExists } from '../fs-utils';
import { errMsg } from '../log-utils';
import type { Runner } from '../runner';
import { quote } from '../shell';

/**
 * Extract one named member from a 7z archive via `7z e -so` and return
 * its stdout. Used by both the `NM_run1.7z` bulk-archive path (PsN
 * -clean<=2) and the per-file `.cor.7z` / `.cnv.7z` per-artifact
 * convention. Returns null on a non-zero exit or thrown error — caller
 * decides whether empty-trim is also a null. `log` is optional; when
 * supplied, failures are surfaced with the archive's basename so the
 * caller's log prefix carries the context.
 */
export async function extract7zMember(opts: {
  runner: Runner;
  archivePath: string;
  /** Member path inside the archive (e.g. `NM_run1/PRDERR`, `psn.cor`). */
  memberName: string;
  /** cwd for the spawned `7z` — typically the archive's directory. */
  cwd: string;
  log?: (msg: string) => void;
}): Promise<string | null> {
  // 7z e -so: extract to stdout. -y answers any prompts; 2>/dev/null
  // mutes 7z's chatty banner so we don't conflate it with file content.
  const cmd = `7z e -so -y ${quote(opts.archivePath)} ${opts.memberName} 2>/dev/null`;
  try {
    const result = await opts.runner.run(cmd, opts.cwd);
    if (result.code !== 0) {
      opts.log?.(
        `7z extraction returned ${result.code} for ${path.basename(opts.archivePath)}`,
      );
      return null;
    }
    return result.stdout;
  } catch (e) {
    opts.log?.(
      `7z extraction threw for ${path.basename(opts.archivePath)}: ${errMsg(e)}`,
    );
    return null;
  }
}

export interface ReadArchivedFileOptions<TExtra extends object = Record<string, never>> {
  /** Absolute path to the run's `modelfit_dir<N>`. */
  modelfitDir: string;
  /**
   * File name to look up (the `NM_run1/<member>` filename and the .7z
   * member name — they're the same). E.g. `'PRDERR'`, `'FMSG'`,
   * `'psn.grd'`.
   */
  memberName: string;
  /** Runner used for archive extraction. Plain-file path doesn't need one. */
  runner?: Runner;
  /**
   * Optional classifier — given the raw content, return any extra
   * fields to merge into the result. Lets callers add e.g.
   * `hasErrors`, `lineCount`, etc. without forking the read logic.
   */
  classify?: (content: string) => TExtra;
}

export interface ArchivedFileContent {
  content: string;
  /** Where the content came from — useful when surfacing in the UI. */
  source: 'plain' | 'archive';
}

const ARCHIVE_NAME = 'NM_run1.7z';

export async function readArchivedFile<TExtra extends object = Record<string, never>>(
  opts: ReadArchivedFileOptions<TExtra>,
): Promise<(ArchivedFileContent & TExtra) | null> {
  const result = await readPlainOrArchive(opts);
  if (!result) return null;
  const extra = opts.classify ? opts.classify(result.content) : ({} as TExtra);
  return { ...result, ...extra };
}

async function readPlainOrArchive(opts: {
  modelfitDir: string;
  memberName: string;
  runner?: Runner;
}): Promise<ArchivedFileContent | null> {
  const plainPath = path.join(opts.modelfitDir, 'NM_run1', opts.memberName);
  if (await pathExists(plainPath)) {
    try {
      const content = await fs.readFile(plainPath, 'utf8');
      if (content.trim() === '') return null;
      return { content, source: 'plain' };
    } catch {
      // Race between exists() and read — fall through to archive.
    }
  }

  const archivePath = path.join(opts.modelfitDir, ARCHIVE_NAME);
  if (!opts.runner || !(await pathExists(archivePath))) return null;

  // Member path MUST include the `NM_run1/` prefix — `7z e -so` with a
  // bare name (e.g. `psn.xml`) returns 0 bytes for files inside a
  // subdirectory; the subpath form `NM_run1/psn.xml` matches. Mirrors
  // the plain-file convention above (`<modelfitDir>/NM_run1/<member>`)
  // so callers pass bare names for both paths uniformly.
  const content = await extract7zMember({
    runner: opts.runner,
    archivePath,
    memberName: `NM_run1/${opts.memberName}`,
    cwd: opts.modelfitDir,
  });
  if (content === null || content.trim() === '') return null;
  return { content, source: 'archive' };
}
