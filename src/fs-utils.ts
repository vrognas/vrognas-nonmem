// Tiny shared filesystem helpers. Kept here to avoid the same
// `try { await fs.access(p); return true } catch { return false }`
// reimplementation drifting between modules.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** True iff `p` exists and is accessible. Never throws. */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Last directory segment of a path's parent — i.e. `path.basename(path.dirname(p))`.
 * Used as a disambiguator in the lineage view (showing `step1/run1` vs
 * `step2/run1` rather than just `run1`) and in QuickPick descriptions
 * (`<parent-dir> · OFV = …`). Returns an empty string when the parent
 * is a filesystem root (`/`, `C:\`).
 */
export function parentDirName(p: string): string {
  return path.basename(path.dirname(p));
}

/**
 * Locate `<dir>/<stem>.<ext>` for the first ext in `exts` that exists.
 * Cheap path first (exact-case `path.join` + `pathExists`); falls
 * back to a case-insensitive directory scan if none of the cheap
 * probes hit (some pharmacometricians use `Run001.MOD`). Returns
 * null when nothing matches or `dir` is unreadable.
 *
 * Pure node-fs (no vscode imports) so it's testable from vitest with
 * `mkdtemp` fixtures. Caller wraps in `vscode.Uri.file(...)` if needed.
 */
export async function findSiblingByExt(
  dir: string,
  stem: string,
  exts: readonly string[],
): Promise<string | null> {
  for (const ext of exts) {
    const candidate = path.join(dir, stem + ext);
    if (await pathExists(candidate)) return candidate;
  }
  try {
    const entries = await fs.readdir(dir);
    const targetStem = stem.toLowerCase();
    const lowerExts = exts.map((e) => e.toLowerCase());
    for (const entry of entries) {
      const ext = path.extname(entry).toLowerCase();
      if (!lowerExts.includes(ext)) continue;
      if (path.basename(entry, path.extname(entry)).toLowerCase() === targetStem) {
        return path.join(dir, entry);
      }
    }
  } catch {
    // dir unreadable; treat as no match
  }
  return null;
}
