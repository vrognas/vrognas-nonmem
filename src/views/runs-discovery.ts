// Run discovery — scans a remote directory tree for `.lst` files (the
// universal NONMEM-output marker) and groups them into "run directories".
// Supports our own `~/positron-nonmem/<id>/m.lst` layout, Pirana flat
// `<dir>/run01.lst`, PsN nested `<dir>/NM_run1/psn-1.lst`, and any
// hand-rolled folder containing one or more .lst files.
//
// Pure-ish: the I/O is delegated to a Transport so this module is
// trivially unit-testable with a stub.
import type { Transport } from '../transport';

export interface RunDir {
  /** Absolute (or `~/…`) remote path of the run directory. */
  remotePath: string;
  /** Path relative to the configured root, suitable for display. Empty when `remotePath === root`. */
  relativePath: string;
  /** Most-recent `.lst` mtime within the dir, Unix epoch seconds. */
  mtime: number;
  /** Filename of the primary `.lst` used as the default open target. Prefers `m.lst`; falls back to the alphabetically first. */
  primaryLst: string;
  /** All `.lst` filenames present in the dir (sorted). */
  lstFiles: string[];
}

/** quote a remote path (mirror of ssh-transport.quoteRemotePath; kept local to avoid an import cycle). */
function quote(p: string): string {
  const escapeSingle = (s: string): string => s.replace(/'/g, `'\\''`);
  if (p === '~') return '"$HOME"';
  if (p.startsWith('~/')) return `"$HOME"/'${escapeSingle(p.slice(2))}'`;
  return `'${escapeSingle(p)}'`;
}

/**
 * Discover run-directories under `root`. A "run-directory" is any
 * directory containing at least one `.lst` file. Directories are
 * returned sorted by their most-recent `.lst` mtime (descending), so
 * the freshest run lands at the top regardless of naming convention.
 */
export async function discoverRuns(
  transport: Transport,
  root: string,
  maxDepth = 4,
): Promise<RunDir[]> {
  // 2>/dev/null swallows "Permission denied" noise from any unreadable
  // subdirs without failing the whole scan. Tab-separated for safe parsing.
  const cmd =
    `find ${quote(root)} -maxdepth ${maxDepth} -type f -name '*.lst' ` +
    `-printf '%h\\t%f\\t%T@\\n' 2>/dev/null`;
  const result = await transport.run(cmd);
  if (result.code !== 0 && !result.stdout.trim()) {
    // root absent (or find errored hard); empty list rather than throw —
    // tree view shows "no runs" rather than blowing up.
    return [];
  }
  return groupLstHits(result.stdout, root);
}

/**
 * Pure parser: takes raw `find` output and bundles it into RunDir
 * entries. Exported for unit testing without a Transport.
 */
export function groupLstHits(findStdout: string, root: string): RunDir[] {
  const byDir = new Map<string, { lstFiles: Set<string>; mtime: number }>();
  for (const line of findStdout.split('\n')) {
    if (!line) continue;
    const [dir, file, mtimeStr] = line.split('\t');
    if (!dir || !file || mtimeStr === undefined) continue;
    const mtime = parseFloat(mtimeStr);
    const entry = byDir.get(dir) ?? { lstFiles: new Set(), mtime: 0 };
    entry.lstFiles.add(file);
    entry.mtime = Math.max(entry.mtime, isNaN(mtime) ? 0 : mtime);
    byDir.set(dir, entry);
  }
  const runs: RunDir[] = Array.from(byDir.entries()).map(([dir, e]) => {
    const lstFiles = Array.from(e.lstFiles).sort();
    return {
      remotePath: dir,
      relativePath: relativeTo(dir, root),
      mtime: e.mtime,
      primaryLst: lstFiles.includes('m.lst') ? 'm.lst' : lstFiles[0],
      lstFiles,
    };
  });
  // Most-recent first.
  runs.sort((a, b) => b.mtime - a.mtime);
  return runs;
}

/** Strip the `root` prefix when present; otherwise return `dir` as-is. */
function relativeTo(dir: string, root: string): string {
  // Tolerate `~` vs `$HOME` divergence: find may emit either depending on
  // how the user's shell expanded our `quoteRemotePath` output. We only
  // rely on prefix-equality here.
  if (dir === root) return '';
  if (dir.startsWith(root + '/')) return dir.slice(root.length + 1);
  return dir;
}
