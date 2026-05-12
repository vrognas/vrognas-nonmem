import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { workspace, Uri } from '../__mocks__/vscode';
import { toSettingPath, fromSettingPath } from '../../src/views/lineage-paths';

describe('toSettingPath', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('delegates to workspace.asRelativePath with includeWorkspaceFolder=false', () => {
    const spy = vi.spyOn(workspace, 'asRelativePath').mockReturnValue('run001.mod');
    expect(toSettingPath('/work/run001.mod')).toBe('run001.mod');
    expect(spy).toHaveBeenCalledWith('/work/run001.mod', false);
  });

  it('returns input unchanged when outside any workspace folder (asRelativePath fallback)', () => {
    vi.spyOn(workspace, 'asRelativePath').mockImplementation((p) =>
      typeof p === 'string' ? p : p.fsPath,
    );
    expect(toSettingPath('/elsewhere/run.mod')).toBe('/elsewhere/run.mod');
  });
});

describe('fromSettingPath', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.spyOn(workspace, 'workspaceFolders', 'get').mockReturnValue(undefined);
  });

  it('passes absolute paths through unchanged (legacy entry back-compat)', () => {
    vi.spyOn(workspace, 'workspaceFolders', 'get').mockReturnValue([
      { uri: Uri.file('/work'), name: 'work', index: 0 },
    ]);
    const abs = path.resolve('/legacy/run.mod');
    expect(fromSettingPath(abs)).toBe(abs);
  });

  it('resolves relative paths against the first workspace folder', () => {
    vi.spyOn(workspace, 'workspaceFolders', 'get').mockReturnValue([
      { uri: Uri.file('/work'), name: 'work', index: 0 },
    ]);
    expect(fromSettingPath('run001.mod')).toBe(path.join('/work', 'run001.mod'));
  });

  it('returns input unchanged when no workspace folders are open', () => {
    vi.spyOn(workspace, 'workspaceFolders', 'get').mockReturnValue(undefined);
    expect(fromSettingPath('run001.mod')).toBe('run001.mod');
  });

  it('first folder wins on multi-folder workspaces', () => {
    vi.spyOn(workspace, 'workspaceFolders', 'get').mockReturnValue([
      { uri: Uri.file('/work-a'), name: 'a', index: 0 },
      { uri: Uri.file('/work-b'), name: 'b', index: 1 },
    ]);
    expect(fromSettingPath('shared/m.mod')).toBe(path.join('/work-a', 'shared/m.mod'));
  });

  it('round-trip: toSettingPath then fromSettingPath returns the absolute input', () => {
    vi.spyOn(workspace, 'workspaceFolders', 'get').mockReturnValue([
      { uri: Uri.file('/work'), name: 'work', index: 0 },
    ]);
    // toSettingPath would delegate to asRelativePath — emulate the
    // "in workspace → relative" case here.
    vi.spyOn(workspace, 'asRelativePath').mockReturnValue('runs/run001.mod');
    const stored = toSettingPath('/work/runs/run001.mod');
    expect(stored).toBe('runs/run001.mod');
    expect(fromSettingPath(stored)).toBe(path.join('/work', 'runs/run001.mod'));
  });
});
