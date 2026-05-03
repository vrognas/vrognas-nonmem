import * as vscode from 'vscode';
import type * as positron from 'positron';
import { LocalRunner, type Runner } from '../runner';
import { buildRuntimeMetadata } from './runtime-metadata';
import { NonmemSession } from './runtime-session';
import type { PositronApi } from '../positron-api';

// LanguageRuntimeManager for NONMEM. Single runtime — the local nmfe76
// install. Multi-runtime would mean multiple NONMEM versions on PATH,
// which we don't model yet.

export interface NonmemRuntimeManagerDeps {
  positron: PositronApi;
  /** NONMEM version probed at activation; falls back to "unknown". */
  nonmemVersion: string;
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
  private readonly nonmemVersion: string;
  private readonly navigator: ((uri: vscode.Uri, line: number) => void) | undefined;
  private readonly runner: Runner;
  /** Live NonmemSession instances spawned by createSession; pruned on session end. */
  private readonly liveSessions = new Set<NonmemSession>();

  constructor(_context: vscode.ExtensionContext, deps: NonmemRuntimeManagerDeps) {
    this.positron = deps.positron;
    this.nonmemVersion = deps.nonmemVersion;
    this.navigator = deps.navigator;
    this.runner = deps.runner ?? new LocalRunner();
  }

  /** Snapshot of currently-live sessions; used by the editor watcher to push parsed-model updates. */
  getSessions(): readonly NonmemSession[] {
    return [...this.liveSessions];
  }

  async *discoverAllRuntimes(): AsyncGenerator<positron.LanguageRuntimeMetadata> {
    yield this.buildMetadata();
  }

  async recommendedWorkspaceRuntime(): Promise<positron.LanguageRuntimeMetadata | undefined> {
    return this.buildMetadata();
  }

  async createSession(
    runtimeMetadata: positron.LanguageRuntimeMetadata,
    sessionMetadata: positron.RuntimeSessionMetadata,
  ): Promise<positron.LanguageRuntimeSession> {
    const session = new NonmemSession(runtimeMetadata, sessionMetadata, {
      positron: this.positron,
      runner: this.runner,
      navigator: this.navigator,
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
    this._onDidDiscoverRuntime.dispose();
  }

  private buildMetadata(): positron.LanguageRuntimeMetadata {
    return buildRuntimeMetadata({
      startupBehavior: this.positron.LanguageRuntimeStartupBehavior.Explicit,
      sessionLocation: this.positron.LanguageRuntimeSessionLocation.Workspace,
      nonmemVersion: this.nonmemVersion,
    });
  }
}
