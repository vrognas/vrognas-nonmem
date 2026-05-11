import * as vscode from 'vscode';
import type * as positron from 'positron';
import { LocalRunner, type Runner } from '../runner';
import type { NmVersionEntry } from '../psn-conf';
import { buildRuntimeMetadata } from './runtime-metadata';
import { NonmemSession } from './runtime-session';
import type { PositronApi } from '../positron-api';

// LanguageRuntimeManager for NONMEM. Yields one runtime per psn.conf
// [nm_versions] entry so the user can pick "NONMEM 7.6", "NONMEM 7.5
// (75)", etc. from the session picker. The picked entry's label lives
// in runtimeMetadata.extraRuntimeData.nmVersionLabel; createSession
// reads it back so the spawned session knows which `-nm_version=<label>`
// to pass through to PsN's `execute`.

export interface NonmemRuntimeManagerDeps {
  positron: PositronApi;
  /** All psn.conf nm_versions entries to register; one runtime per entry. */
  nmVersions: readonly NmVersionEntry[];
  /** Forwarded to every spawned NonmemSession; see NonmemSessionDeps.navigator. */
  navigator?: (uri: vscode.Uri, line: number) => void;
  /** Runner used by spawned sessions (defaults to LocalRunner). */
  runner?: Runner;
}

export class NonmemRuntimeManager implements positron.LanguageRuntimeManager {
  private readonly _onDidDiscoverRuntime =
    new vscode.EventEmitter<positron.LanguageRuntimeMetadata>();
  readonly onDidDiscoverRuntime = this._onDidDiscoverRuntime.event;

  private readonly positron: PositronApi;
  private readonly nmVersions: readonly NmVersionEntry[];
  private readonly navigator: ((uri: vscode.Uri, line: number) => void) | undefined;
  private readonly runner: Runner;
  private readonly liveSessions = new Set<NonmemSession>();

  constructor(_context: vscode.ExtensionContext, deps: NonmemRuntimeManagerDeps) {
    this.positron = deps.positron;
    this.nmVersions = deps.nmVersions;
    this.navigator = deps.navigator;
    this.runner = deps.runner ?? new LocalRunner();
  }

  /** Snapshot of currently-live sessions; used by the editor watcher to push parsed-model updates. */
  getSessions(): readonly NonmemSession[] {
    return [...this.liveSessions];
  }

  async *discoverAllRuntimes(): AsyncGenerator<positron.LanguageRuntimeMetadata> {
    for (const entry of this.nmVersions) yield this.buildMetadata(entry);
  }

  async recommendedWorkspaceRuntime(): Promise<positron.LanguageRuntimeMetadata | undefined> {
    // Caller sorts so `default` is first; offer it as the picker default.
    const first = this.nmVersions[0];
    return first ? this.buildMetadata(first) : undefined;
  }

  async createSession(
    runtimeMetadata: positron.LanguageRuntimeMetadata,
    sessionMetadata: positron.RuntimeSessionMetadata,
  ): Promise<positron.LanguageRuntimeSession> {
    // Read the nm_version label back from metadata so the session
    // knows which psn.conf entry Positron picked for it — used as
    // `-nm_version=<label>` in runModel.
    const label = (runtimeMetadata.extraRuntimeData as { nmVersionLabel?: string } | undefined)
      ?.nmVersionLabel;
    const session = new NonmemSession(runtimeMetadata, sessionMetadata, {
      positron: this.positron,
      runner: this.runner,
      navigator: this.navigator,
      nmVersionLabel: label,
    });
    this.liveSessions.add(session);
    session.onDidEndSession(() => this.liveSessions.delete(session));
    return session;
  }

  async validateMetadata(
    metadata: positron.LanguageRuntimeMetadata,
  ): Promise<positron.LanguageRuntimeMetadata> {
    return metadata;
  }

  dispose(): void {
    // Dispose every live session so their per-session emitters
    // (_onDidReceiveRuntimeMessage / _onDidChangeRuntimeState /
    // _onDidEndSession / _onDidUpdateResourceUsage — 4 per session)
    // don't leak when the manager is disposed during deactivate or after
    // the double-register guard kicks in. Sessions also handle this
    // themselves on shutdown, but defensive belt-and-suspenders.
    for (const session of this.liveSessions) session.dispose();
    this.liveSessions.clear();
    this._onDidDiscoverRuntime.dispose();
  }

  private buildMetadata(entry: NmVersionEntry): positron.LanguageRuntimeMetadata {
    return buildRuntimeMetadata({
      startupBehavior: this.positron.LanguageRuntimeStartupBehavior.Explicit,
      sessionLocation: this.positron.LanguageRuntimeSessionLocation.Workspace,
      nmVersion: entry,
    });
  }
}
