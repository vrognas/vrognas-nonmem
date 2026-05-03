// Run discovery — `.lst` is the universal NONMEM output marker. Scans the
// open workspace folders via `vscode.workspace.findFiles`, groups hits by
// parent directory, sorts by mtime descending. Works for our own runs,
// Pirana flat (`run01.lst`), PsN nested (`NM_run1/psn-1.lst`), and any
// hand-rolled folder containing one or more `.lst` files.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

export interface RunDir {
  /** Absolute path to the run directory. */
  dirPath: string;
  /** Path relative to the nearest workspace folder (or `dirPath` when not inside one). */
  relativePath: string;
  /** Most-recent `.lst` mtime within the dir, Unix epoch seconds. */
  mtime: number;
  /** Filename of the primary `.lst` used as the default open target. Prefers `m.lst`. */
  primaryLst: string;
  /** All `.lst` filenames present in the dir (sorted). */
  lstFiles: string[];
}

const LST_GLOB = '**/*.lst';
const EXCLUDE_GLOB = '{**/node_modules/**,**/.git/**}';

/**
 * Scan workspace folders for `.lst` files; group + sort. Returns [] when
 * no workspace is open. Errors during stat are tolerated (entry skipped)
 * to avoid one bad file killing the entire scan.
 */
export async function discoverRuns(): Promise<RunDir[]> {
  const uris = await vscode.workspace.findFiles(LST_GLOB, EXCLUDE_GLOB);
  return groupLstHits(await statHits(uris));
}

interface LstHit {
  dirPath: string;
  fileName: string;
  mtime: number;
}

/** Stat each .lst URI; tolerate failures (vanished files, perms) by dropping the entry. */
async function statHits(uris: readonly vscode.Uri[]): Promise<LstHit[]> {
  const out: LstHit[] = [];
  await Promise.all(
    uris.map(async (uri) => {
      try {
        const s = await fs.stat(uri.fsPath);
        out.push({
          dirPath: path.dirname(uri.fsPath),
          fileName: path.basename(uri.fsPath),
          mtime: Math.floor(s.mtimeMs / 1000),
        });
      } catch {
        // Tolerate races / permission errors; skip this hit silently.
      }
    }),
  );
  return out;
}

/** Pure parser: bundle stat'd .lst hits into RunDir entries. Exported for tests. */
export function groupLstHits(hits: readonly LstHit[]): RunDir[] {
  const byDir = new Map<string, { lstFiles: Set<string>; mtime: number }>();
  for (const h of hits) {
    const entry = byDir.get(h.dirPath) ?? { lstFiles: new Set(), mtime: 0 };
    entry.lstFiles.add(h.fileName);
    entry.mtime = Math.max(entry.mtime, h.mtime);
    byDir.set(h.dirPath, entry);
  }
  const runs: RunDir[] = Array.from(byDir.entries()).map(([dirPath, e]) => {
    const lstFiles = Array.from(e.lstFiles).sort();
    return {
      dirPath,
      relativePath: relativeToWorkspace(dirPath),
      mtime: e.mtime,
      primaryLst: lstFiles.includes('m.lst') ? 'm.lst' : lstFiles[0],
      lstFiles,
    };
  });
  runs.sort((a, b) => b.mtime - a.mtime);
  return runs;
}

/**
 * Strip the workspace root prefix when present; otherwise return `dirPath`
 * as-is. Multiple workspace folders pick the longest matching prefix so
 * the displayed path is the most-specific one.
 */
function relativeToWorkspace(dirPath: string): string {
  const folders = vscode.workspace.workspaceFolders ?? [];
  let best = '';
  for (const f of folders) {
    const root = f.uri.fsPath;
    if ((dirPath === root || dirPath.startsWith(root + path.sep)) && root.length > best.length) {
      best = root;
    }
  }
  if (!best) return dirPath;
  if (dirPath === best) return '';
  return dirPath.slice(best.length + 1);
}
