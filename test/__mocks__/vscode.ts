// Stub of the `vscode` module surface used by `src/`. Loaded by vitest via the
// resolve alias in `vitest.config.ts`. Only contains shapes the unit tests rely
// on indirectly via the type system; runtime behaviour is exercised through the
// fakeConfig pattern, not through these stubs.

export const workspace = {
  getConfiguration: (_section?: string): { get: <T>(key: string) => T | undefined } => ({
    get: <T>(_key: string): T | undefined => undefined,
  }),
};

export const window = {
  createOutputChannel: (_name: string) => ({
    show: (_preserveFocus?: boolean) => undefined,
    appendLine: (_value: string) => undefined,
    dispose: () => undefined,
  }),
  showErrorMessage: async (_msg: string) => undefined,
  showInformationMessage: async (_msg: string) => undefined,
};

export const commands = {
  registerCommand: (_id: string, _handler: (...args: unknown[]) => unknown) => ({
    dispose: () => undefined,
  }),
};

export type ExtensionContext = { subscriptions: { push: (d: unknown) => void } };
export type OutputChannel = ReturnType<typeof window.createOutputChannel>;
export type WorkspaceConfiguration = ReturnType<typeof workspace.getConfiguration>;

// FS provider surface — minimal stubs sufficient for unit tests that
// instantiate RemoteFileSystemProvider. Real VSCode supplies these via
// the host runtime; we mirror just enough shape.
export const FileType = {
  File: 1,
  Directory: 2,
  SymbolicLink: 64,
} as const;

export const Uri = {
  from: (parts: { scheme: string; authority: string; path: string }) => ({
    scheme: parts.scheme,
    authority: parts.authority,
    path: parts.path,
    toString(): string {
      return `${parts.scheme}://${parts.authority}${parts.path}`;
    },
  }),
};
export type Uri = ReturnType<typeof Uri.from>;

export class FileSystemError extends Error {
  static FileNotFound(uri?: Uri): FileSystemError {
    const e = new FileSystemError(`File not found${uri ? `: ${uri.toString()}` : ''}`);
    e.code = 'FileNotFound';
    return e;
  }
  static NoPermissions(msg?: string): FileSystemError {
    const e = new FileSystemError(msg ?? 'No permissions');
    e.code = 'NoPermissions';
    return e;
  }
  code = 'Unknown';
}

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  readonly event = (listener: (e: T) => void): { dispose: () => void } => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  fire(e: T): void {
    for (const l of this.listeners) l(e);
  }
}

export class Disposable {
  constructor(private readonly fn?: () => void) {}
  dispose(): void {
    this.fn?.();
  }
}
