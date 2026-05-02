import * as vscode from 'vscode';
import type * as positron from 'positron';
import { resolveHostProfile, HostProfileError } from '../host-profiles';
import { buildRuntimeMetadata } from './runtime-metadata';
import { NonmemSession } from './runtime-session';
import type { PositronApi } from '../positron-api';

// LanguageRuntimeManager for NONMEM. Yields one runtime per configured
// host alias. For now there's exactly one alias (positronNonmem.host.alias);
// multi-host support lands in M12+ when the v2 backlog is touched.

export interface NonmemRuntimeManagerDeps {
  positron: PositronApi;
}

export class NonmemRuntimeManager implements positron.LanguageRuntimeManager {
  private readonly _onDidDiscoverRuntime =
    new vscode.EventEmitter<positron.LanguageRuntimeMetadata>();
  readonly onDidDiscoverRuntime = this._onDidDiscoverRuntime.event;

  private readonly positron: PositronApi;

  constructor(_context: vscode.ExtensionContext, deps: NonmemRuntimeManagerDeps) {
    this.positron = deps.positron;
  }

  async *discoverAllRuntimes(): AsyncGenerator<positron.LanguageRuntimeMetadata> {
    const metadata = this.tryBuildMetadata();
    if (metadata) yield metadata;
  }

  async recommendedWorkspaceRuntime(): Promise<positron.LanguageRuntimeMetadata | undefined> {
    return this.tryBuildMetadata();
  }

  async createSession(
    runtimeMetadata: positron.LanguageRuntimeMetadata,
    sessionMetadata: positron.RuntimeSessionMetadata,
  ): Promise<positron.LanguageRuntimeSession> {
    return new NonmemSession(runtimeMetadata, sessionMetadata, { positron: this.positron });
  }

  async validateMetadata(
    metadata: positron.LanguageRuntimeMetadata,
  ): Promise<positron.LanguageRuntimeMetadata> {
    // No external resources to validate yet (no binary path to check, no
    // remote handshake). Return as-is so session restoration succeeds
    // across IDE restarts.
    return metadata;
  }

  dispose(): void {
    this._onDidDiscoverRuntime.dispose();
  }

  private tryBuildMetadata(): positron.LanguageRuntimeMetadata | undefined {
    let profile;
    try {
      profile = resolveHostProfile();
    } catch (e) {
      if (e instanceof HostProfileError) return undefined;
      throw e;
    }
    return buildRuntimeMetadata(profile, {
      startupBehavior: this.positron.LanguageRuntimeStartupBehavior.Explicit,
      sessionLocation: this.positron.LanguageRuntimeSessionLocation.Workspace,
    });
  }
}
