import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import type * as positron from 'positron';
import type { PositronApi } from '../positron-api';

// Minimal LanguageRuntimeSession implementation — Chunk 2B.
//
// Goals at this stage:
//   • Implement every member of the LanguageRuntimeSession interface so
//     TypeScript is happy and Positron can drive the lifecycle.
//   • Support the basic state machine: Uninitialized → Starting → Ready →
//     Idle → (Busy on execute) → Idle → Exited.
//   • execute() emits a placeholder Stream message acknowledging the input
//     so the Console pane shows something. Real SSH wiring lands in
//     Chunk 2C.
//   • Throw / no-op the things we genuinely don't support yet (debug,
//     comm clients, fragment completeness checks beyond a default).
//
// Privacy: this class never sees the resolved hostname, only the alias
// (carried in runtimeMetadata.extraRuntimeData.hostAlias). All log lines
// emitted as Stream messages use the alias only.

export interface NonmemSessionDeps {
  positron: PositronApi;
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

  constructor(
    runtimeMetadata: positron.LanguageRuntimeMetadata,
    sessionMetadata: positron.RuntimeSessionMetadata,
    deps: NonmemSessionDeps,
  ) {
    this.runtimeMetadata = runtimeMetadata;
    this.metadata = sessionMetadata;
    this.positron = deps.positron;
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
    void mode; // mode tracking lands when we have history / silent execution semantics

    // Session-level state: this session is busy until execute returns.
    this.transitionState(this.positron.RuntimeState.Busy);
    // Per-execution state message: tells the Console "execution `id` started"
    // so the input box shows the busy spinner / green bar.
    this.emitOnlineState(id, this.positron.RuntimeOnlineState.Busy);

    // Echo input so the Console pane shows what was sent.
    this.emitInput(id, code);
    this.emitStream(
      id,
      this.positron.LanguageRuntimeStreamName.Stdout,
      `[${this.runtimeMetadata.runtimeShortName}] (placeholder — SSH execute lands in M2C)\n`,
    );

    // Per-execution state Idle with matching parent_id signals "execution
    // `id` finished" — without this, the Console keeps the line marked busy
    // and the prompt does not redraw, even if the session-level state goes
    // back to Idle.
    this.emitOnlineState(id, this.positron.RuntimeOnlineState.Idle);
    this.transitionState(this.positron.RuntimeState.Idle);
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
    // No remote process to abort yet. Lands in 2C.
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
    _id: string,
    _type: positron.RuntimeClientType,
    _params: Record<string, unknown>,
    _metadata?: Record<string, unknown>,
  ): Promise<void> {
    // Variables / Plot / DataExplorer / Connection / UI / Help comms all come
    // in M3+. We silently accept the creation request so Positron's session
    // machinery doesn't treat the session as broken; the corresponding panes
    // stay empty (we never emit comm messages on these client IDs) until the
    // wire-format implementation lands. Throwing here put Positron in a
    // half-attached state that froze the Console prompt after execute().
  }

  async listClients(_type?: positron.RuntimeClientType): Promise<Record<string, string>> {
    return {};
  }

  removeClient(_id: string): void {
    // No-op; we don't track clients yet.
  }

  sendClientMessage(
    _client_id: string,
    _message_id: string,
    _message: Record<string, unknown>,
  ): void {
    // No-op; will be implemented when comms exist.
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
}
