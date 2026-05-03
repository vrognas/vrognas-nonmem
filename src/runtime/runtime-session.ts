import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import type * as positron from 'positron';
import type { PositronApi } from '../positron-api';
import type { Transport } from '../transport';
import type { NmtranParsedModel } from '../nmtran-client';
import { mapParsedModelToVariables, resolveAccessKeyLine, type Variable } from './variables-comm';

// LanguageRuntimeSession implementation for NONMEM.
//
// Drives the basic state machine — Uninitialized → Starting → Ready →
// Idle → (Busy on execute) → Idle → Exited — and dispatches each execute()
// to the configured Transport (ssh-out or local). Output streams back as
// Stream / Error messages tied to the execute id so Positron's Console
// pane redraws prompts and tracks per-execution status correctly.
//
// Capabilities deliberately not implemented yet (M3+): debug() throws,
// the runtime-client comms (Variables / Plot / DataExplorer / Connection /
// UI / Help) are silent no-ops so Positron's session machinery doesn't
// treat the session as broken when it tries to wire them up at start.
//
// Privacy: this class never sees the resolved hostname, only the alias
// (carried in runtimeMetadata.extraRuntimeData.hostAlias). The ssh
// transport scrubs hostnames from any propagated stderr; the local
// transport is on the host so there's nothing to scrub.

export interface NonmemSessionDeps {
  positron: PositronApi;
  /**
   * Transport used to run code from execute(). Resolved at Manager
   * creation time so all sync paths in Session can use it directly.
   */
  transport: Transport;
  /**
   * Optional navigation callback fired when the Variables-pane sends a
   * `view` RPC for an equation row. Wired by the extension to
   * `vscode.window.showTextDocument` with a 1-line selection range.
   * Tests pass undefined to keep the session vscode-free.
   */
  navigator?: (uri: vscode.Uri, line: number) => void;
}

export class NonmemSession implements positron.LanguageRuntimeSession {
  // ActiveRuntimeSessionMetadata
  readonly metadata: positron.RuntimeSessionMetadata;
  readonly runtimeMetadata: positron.LanguageRuntimeMetadata;

  // LanguageRuntimeSession-specific state
  runtimeInfo: positron.LanguageRuntimeInfo | undefined;

  private readonly _onDidReceiveRuntimeMessage =
    new vscode.EventEmitter<positron.LanguageRuntimeMessage>();
  readonly onDidReceiveRuntimeMessage = this._onDidReceiveRuntimeMessage.event;

  private readonly _onDidChangeRuntimeState = new vscode.EventEmitter<positron.RuntimeState>();
  readonly onDidChangeRuntimeState = this._onDidChangeRuntimeState.event;

  private readonly _onDidEndSession = new vscode.EventEmitter<positron.LanguageRuntimeExit>();
  readonly onDidEndSession = this._onDidEndSession.event;

  private readonly _onDidUpdateResourceUsage =
    new vscode.EventEmitter<positron.RuntimeResourceUsage>();
  readonly onDidUpdateResourceUsage = this._onDidUpdateResourceUsage.event;

  private state: positron.RuntimeState;
  private workingDirectory: string | undefined;
  private sessionName: string;
  private readonly positron: PositronApi;
  private readonly transport: Transport;
  private readonly navigator: ((uri: vscode.Uri, line: number) => void) | undefined;
  /** Open Variables-comm client IDs we should keep in sync. */
  private readonly variablesClients = new Set<string>();
  /** Most recently received parsed-model snapshot — pushed to new + existing Variables comms. */
  private currentParsedModel: NmtranParsedModel | null = null;
  /** URI of the editor that produced `currentParsedModel`; needed to resolve `view` RPCs back to the source file. */
  private currentSourceUri: vscode.Uri | null = null;

  constructor(
    runtimeMetadata: positron.LanguageRuntimeMetadata,
    sessionMetadata: positron.RuntimeSessionMetadata,
    deps: NonmemSessionDeps,
  ) {
    this.runtimeMetadata = runtimeMetadata;
    this.metadata = sessionMetadata;
    this.positron = deps.positron;
    this.transport = deps.transport;
    this.navigator = deps.navigator;
    this.state = this.positron.RuntimeState.Uninitialized;
    this.workingDirectory = sessionMetadata.workingDirectory;
    this.sessionName = runtimeMetadata.runtimeName;
  }

  /** Current working directory tracked for the session (for M3+ remote runs). */
  getWorkingDirectory(): string | undefined {
    return this.workingDirectory;
  }

  // ----- BaseLanguageRuntimeSession -----

  async getDynState(): Promise<positron.LanguageRuntimeDynState> {
    return {
      inputPrompt: '> ',
      continuationPrompt: '+ ',
      sessionName: this.sessionName,
    };
  }

  execute(
    code: string,
    id: string,
    mode: positron.RuntimeCodeExecutionMode,
    _errorBehavior: positron.RuntimeErrorBehavior,
    _codeLocation?: positron.Utf8Location,
    _executionMetadata?: Record<string, unknown>,
  ): void {
    void mode; // mode tracking lands with history / silent execution semantics

    // Session-level state: busy until the async dispatch completes.
    this.transitionState(this.positron.RuntimeState.Busy);
    // Per-execution state — tied to `id` so Positron knows which line is
    // running and shows the busy gutter for it specifically.
    this.emitOnlineState(id, this.positron.RuntimeOnlineState.Busy);
    // Echo input verbatim so the Console pane shows what was sent.
    this.emitInput(id, code);

    // Fire-and-forget the async transport call. We can't await here because
    // the LanguageRuntimeSession.execute interface is synchronous.
    void this.dispatchToTransport(code, id);
  }

  private async dispatchToTransport(code: string, id: string): Promise<void> {
    try {
      const result = await this.transport.run(code);
      if (result.stdout) {
        this.emitStream(id, this.positron.LanguageRuntimeStreamName.Stdout, result.stdout);
      }
      if (result.stderr) {
        this.emitStream(id, this.positron.LanguageRuntimeStreamName.Stderr, result.stderr);
      }
      // Surface a non-zero exit code to the user. Don't repeat it for code 0
      // and don't conflate it with the SSH transport's own 255 (which is
      // already reported via TransportError catch below).
      if (result.code !== null && result.code !== 0) {
        this.emitStream(
          id,
          this.positron.LanguageRuntimeStreamName.Stderr,
          `[exit code: ${result.code}]\n`,
        );
      }
    } catch (e) {
      // Anything that bubbles out of transport.run — TransportError or a
      // programmer bug — surfaces as a structured Error in the Console
      // rather than getting swallowed.
      const name = e instanceof Error ? e.name : 'Error';
      const message = e instanceof Error ? e.message : String(e);
      this.emitError(id, name, message);
    } finally {
      // Per-execution Idle MUST fire (or the prompt won't redraw); paired
      // with the session-level Idle.
      this.emitOnlineState(id, this.positron.RuntimeOnlineState.Idle);
      this.transitionState(this.positron.RuntimeState.Idle);
    }
  }

  async shutdown(_exitReason: positron.RuntimeExitReason): Promise<void> {
    this.transitionState(this.positron.RuntimeState.Exiting);
    this.transitionState(this.positron.RuntimeState.Exited);
    this._onDidEndSession.fire({
      runtime_name: this.runtimeMetadata.runtimeName,
      session_name: this.sessionName,
      exit_code: 0,
      reason: _exitReason,
      message: '',
    });
  }

  // ----- LanguageRuntimeSession (lifecycle) -----

  async start(): Promise<positron.LanguageRuntimeInfo> {
    this.transitionState(this.positron.RuntimeState.Starting);
    const info: positron.LanguageRuntimeInfo = {
      banner: `Positron NONMEM session attached to host alias [${this.runtimeMetadata.runtimeShortName}]\n`,
      implementation_version: this.runtimeMetadata.runtimeVersion,
      language_version: this.runtimeMetadata.languageVersion,
      input_prompt: '> ',
      continuation_prompt: '+ ',
    };
    this.runtimeInfo = info;

    // Positron prints info.banner itself in the Console pane; we don't
    // emit it as a Stream (doing so duplicated the line at startup).
    this.transitionState(this.positron.RuntimeState.Ready);
    this.transitionState(this.positron.RuntimeState.Idle);
    return info;
  }

  async interrupt(): Promise<void> {
    // We can't currently abort the in-flight transport.run(). Killing the
    // ssh / shell child needs a handle the Transport doesn't expose yet
    // (M3+ adds that when long NONMEM runs make it actually matter).
    // For now, we just flip session state back to Idle so the UI unfreezes.
    this.transitionState(this.positron.RuntimeState.Idle);
  }

  async restart(workingDirectory?: string): Promise<void> {
    if (workingDirectory) this.workingDirectory = workingDirectory;
    await this.shutdown(this.positron.RuntimeExitReason.Restart);
    await this.start();
  }

  async forceQuit(): Promise<void> {
    this.transitionState(this.positron.RuntimeState.Exited);
    this._onDidEndSession.fire({
      runtime_name: this.runtimeMetadata.runtimeName,
      session_name: this.sessionName,
      exit_code: 137, // SIGKILL convention
      reason: this.positron.RuntimeExitReason.ForcedQuit,
      message: 'forceQuit',
    });
  }

  updateSessionName(sessionName: string): void {
    this.sessionName = sessionName;
  }

  async setWorkingDirectory(dir: string): Promise<void> {
    this.workingDirectory = dir;
  }

  // ----- LanguageRuntimeSession (capabilities we don't yet support) -----

  // NONMEM has no DAP — Positron may call debug() if a debug session
  // starts; throwing is the documented pattern (positron-r/session.ts
  // does the same).
  debug(_request: positron.DebugProtocolRequest): Thenable<positron.DebugProtocolResponse> {
    throw new Error('Debugging is not supported for NONMEM sessions.');
  }

  // We currently treat every fragment as complete. NMTRAN compiles
  // whole-file; there's no notion of incomplete fragments at the runtime
  // level. (Future: parse for unbalanced $RECORD blocks.)
  async isCodeFragmentComplete(_code: string): Promise<positron.RuntimeCodeFragmentStatus> {
    return this.positron.RuntimeCodeFragmentStatus.Complete;
  }

  async createClient(
    id: string,
    type: positron.RuntimeClientType,
    _params: Record<string, unknown>,
    _metadata?: Record<string, unknown>,
  ): Promise<void> {
    // Variables comm: track the client id and immediately push the current
    // parsed-model snapshot (if any). Other comm types (Plot/DataExplorer/
    // Connection/UI/Help) are accepted silently so Positron's session
    // machinery doesn't treat the session as broken.
    if (type === this.positron.RuntimeClientType.Variables) {
      this.variablesClients.add(id);
      this.pushVariablesRefresh(id);
    }
  }

  async listClients(type?: positron.RuntimeClientType): Promise<Record<string, string>> {
    if (type !== undefined && type !== this.positron.RuntimeClientType.Variables) {
      return {};
    }
    const result: Record<string, string> = {};
    for (const id of this.variablesClients) {
      result[id] = this.positron.RuntimeClientType.Variables;
    }
    return result;
  }

  removeClient(id: string): void {
    this.variablesClients.delete(id);
  }

  sendClientMessage(
    client_id: string,
    message_id: string,
    message: Record<string, unknown>,
  ): void {
    if (!this.variablesClients.has(client_id)) return;
    // Wire format is JSON-RPC per positron/comms/variables-backend-openrpc.json.
    // The frontend tracks each request by id and won't dispatch a second
    // request for the same row until the first one resolves — so for any
    // RPC we receive we MUST emit a correlated response (parent_id =
    // message_id, body carrying jsonrpc result) or the row's "View" icon
    // gets stuck in "View Queued…".
    if (message['method'] === 'list') {
      // Per OpenRPC, `list` returns the variable set as the result. The
      // proactive `refresh` event is for setParsedModel / createClient,
      // not for `list` — sending both was double-work.
      this.emitCommReply(client_id, message_id, this.buildVariablesPayload());
      return;
    }
    if (message['method'] === 'view') {
      this.handleViewRpc(message['params']);
      // `view` is a side-effect call — null result is the documented shape.
      this.emitCommReply(client_id, message_id, null);
    }
  }

  private handleViewRpc(params: unknown): void {
    if (!this.navigator || !this.currentSourceUri || !this.currentParsedModel) return;
    // Per variables-backend-openrpc.json: view.params.path is string[].
    // For top-level vars it's a single-element array carrying the access_key.
    const path = (params as { path?: unknown } | undefined)?.path;
    if (!Array.isArray(path) || path.length === 0) return;
    const accessKey = path[path.length - 1];
    if (typeof accessKey !== 'string') return;
    const line = resolveAccessKeyLine(this.currentParsedModel, accessKey);
    if (line === null) return;
    this.navigator(this.currentSourceUri, line);
  }

  /**
   * Update the current model snapshot (and the source URI, when the model
   * came from an editor) and push a fresh `refresh` event to every open
   * Variables comm. URI is null when no editor is active or the active
   * file isn't an NMTRAN document — view-RPC lookups fall through in that case.
   */
  setParsedModel(model: NmtranParsedModel | null, uri: vscode.Uri | null = null): void {
    this.currentParsedModel = model;
    this.currentSourceUri = model ? uri : null;
    for (const id of this.variablesClients) this.pushVariablesRefresh(id);
  }

  private pushVariablesRefresh(commId: string): void {
    // Frontend event from positron/comms/variables-frontend-openrpc.json:
    //   method=refresh, params={ variables, length, version }
    this.emitCommMessage(commId, {
      method: 'refresh',
      params: this.buildVariablesPayload(),
    });
  }

  /** {variables, length, version} payload reused by both `list` replies and `refresh` events. */
  private buildVariablesPayload(): { variables: Variable[]; length: number; version: number } {
    const variables = this.currentParsedModel
      ? mapParsedModelToVariables(this.currentParsedModel)
      : [];
    return { variables, length: variables.length, version: 0 };
  }

  /**
   * Send a JSON-RPC 2.0 response for an inbound RPC. parent_id correlates
   * to the original message_id so Positron's frontend can resolve the
   * pending request. Without this, has_viewer rows stick on "View Queued…"
   * after the first double-click.
   */
  private emitCommReply(commId: string, messageId: string, result: unknown): void {
    this.emitCommMessage(
      commId,
      { jsonrpc: '2.0', id: messageId, result: result as Record<string, unknown> | null },
      messageId,
    );
  }

  replyToPrompt(_id: string, _reply: string): void {
    // No-op; we don't issue prompts.
  }

  // Disposable
  dispose(): void {
    this._onDidReceiveRuntimeMessage.dispose();
    this._onDidChangeRuntimeState.dispose();
    this._onDidEndSession.dispose();
    this._onDidUpdateResourceUsage.dispose();
  }

  // ----- internals -----

  private transitionState(next: positron.RuntimeState): void {
    if (this.state === next) return;
    this.state = next;
    this._onDidChangeRuntimeState.fire(next);
  }

  private emitStream(
    parentId: string,
    name: positron.LanguageRuntimeStreamName,
    text: string,
  ): void {
    const message: positron.LanguageRuntimeStream = {
      id: randomUUID(),
      parent_id: parentId,
      when: new Date().toISOString(),
      type: this.positron.LanguageRuntimeMessageType.Stream,
      name,
      text,
    };
    this._onDidReceiveRuntimeMessage.fire(message);
  }

  private emitInput(parentId: string, code: string): void {
    const message: positron.LanguageRuntimeInput = {
      id: randomUUID(),
      parent_id: parentId,
      when: new Date().toISOString(),
      type: this.positron.LanguageRuntimeMessageType.Input,
      code,
      execution_count: 0,
    };
    this._onDidReceiveRuntimeMessage.fire(message);
  }

  /**
   * Per-execution online-state message. The `parent_id` MUST match the
   * id passed to execute() — Positron uses that pairing to know which
   * execution started/finished and redraws the Console prompt accordingly.
   * Without this, the Console keeps the line marked busy (green bar in
   * the gutter) and never re-shows the prompt.
   */
  private emitOnlineState(parentId: string, state: positron.RuntimeOnlineState): void {
    const message: positron.LanguageRuntimeState = {
      id: randomUUID(),
      parent_id: parentId,
      when: new Date().toISOString(),
      type: this.positron.LanguageRuntimeMessageType.State,
      state,
    };
    this._onDidReceiveRuntimeMessage.fire(message);
  }

  private emitCommMessage(
    commId: string,
    data: Record<string, unknown>,
    parentId = '',
  ): void {
    const message: positron.LanguageRuntimeCommMessage = {
      id: randomUUID(),
      parent_id: parentId,
      when: new Date().toISOString(),
      type: this.positron.LanguageRuntimeMessageType.CommData,
      comm_id: commId,
      data,
    };
    this._onDidReceiveRuntimeMessage.fire(message);
  }

  private emitError(parentId: string, name: string, message: string): void {
    const msg: positron.LanguageRuntimeError = {
      id: randomUUID(),
      parent_id: parentId,
      when: new Date().toISOString(),
      type: this.positron.LanguageRuntimeMessageType.Error,
      name,
      message,
      traceback: [],
    };
    this._onDidReceiveRuntimeMessage.fire(msg);
  }
}
