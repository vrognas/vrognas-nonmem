// Path-format helpers for the workspace settings that persist lineage
// state (`nonmem.lineageOverrides`, `nonmem.lineages`).
//
// Storage policy: write workspace-relative when the absolute path lives
// inside a workspace folder; fall back to absolute otherwise. Reads
// accept either form for backward compat — entries written before this
// helper landed are absolute, and stay absolute on disk until the user
// re-edits them (which then rewrites them to relative).
//
// Why: absolute paths in settings.json embed the user's home dir (or
// the remote-FS layout when in Positron Remote SSH). Settings files
// commonly get committed or shared for support; storing the relative
// form keeps the workspace portable AND removes a privacy
// side-channel CLAUDE.md treats as load-bearing.

import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * Convert an absolute model path to the form persisted in settings.
 * `vscode.workspace.asRelativePath(p, false)` returns a workspace-
 * relative path when `p` is inside any workspace folder, or `p`
 * unchanged otherwise. We never want the workspace-folder name
 * prefix in the relative form (hence the `false`).
 */
export function toSettingPath(absPath: string): string {
  return vscode.workspace.asRelativePath(absPath, false);
}

/**
 * Convert a path from settings into the absolute form used downstream
 * (comparisons against `LineageNode.modelPath` etc.). Absolute paths
 * pass through unchanged (back-compat for entries written before this
 * helper). Relative paths resolve against the first workspace folder
 * — single-folder workspaces are the common case and multi-folder is
 * unusual enough that ambiguity gets caught downstream by
 * `findStaleOverrides` flagging the unresolved entry.
 */
export function fromSettingPath(stored: string): string {
  if (path.isAbsolute(stored)) return stored;
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return stored;
  return path.join(folders[0].uri.fsPath, stored);
}
