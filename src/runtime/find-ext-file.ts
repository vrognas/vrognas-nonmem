// findExtFile — locate the `.ext` corresponding to a `<basename>.lst`,
// across the two layouts we expect in practice:
//
//   1. Pirana / nmfe-direct: `<dir>/<basename>.ext` next to the .lst.
//   2. PsN with `-nm_output=ext,...` (our default): PsN copies the
//      .ext into `<dir>/modelfit_dir<N>/<basename>.ext`. We pick the
//      highest-N (latest run) when multiple modelfit_dirs exist.
//
// A third layout — PsN without `-nm_output` — leaves the file at
// `<dir>/modelfit_dir<N>/NM_run1/psn.ext`. We don't probe that here:
// the extension always passes `-nm_output` (run-model.ts), so the only
// way to land in that layout is a run done outside the extension. If
// that becomes a real-world need, add a third tier here.
//
// Pure module: no vscode imports; tested with mkdtemp fixtures.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathExists } from '../fs-utils';

const MODELFIT_DIR_RE = /^modelfit_dir(\d+)$/;

/**
 * List `modelfit_dir<N>` subdirectories sorted descending by N
 * (highest = latest run). Returns an empty array when the parent dir
 * is unreadable. Single source of truth for the regex + sort across
 * `findExtFile` (cascades through all candidates) and
 * `findLatestModelfitDir` (just wants the top).
 */
export async function listModelfitDirs(
  dir: string,
): Promise<{ n: number; path: string }[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { n: number; path: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const m = MODELFIT_DIR_RE.exec(entry.name);
    if (!m) continue;
    out.push({ n: Number(m[1]), path: path.join(dir, entry.name) });
  }
  out.sort((a, b) => b.n - a.n);
  return out;
}

/**
 * Given the path to a `<basename>.lst`, return the path to the
 * matching `<basename>.ext` from whichever layout has it. Null when
 * neither layout has a file. Caller decides what to do (Variables-pane
 * stays init-only, etc.).
 */
export async function findExtFile(lstPath: string): Promise<string | null> {
  const dir = path.dirname(lstPath);
  const base = path.basename(lstPath, path.extname(lstPath));
  const extName = `${base}.ext`;

  // Tier 1: top-level sibling.
  const topLevel = path.join(dir, extName);
  if (await pathExists(topLevel)) return topLevel;

  // Tier 2: highest-N modelfit_dir<N> with a matching .ext inside.
  for (const dirInfo of await listModelfitDirs(dir)) {
    const candidate = path.join(dirInfo.path, extName);
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}
