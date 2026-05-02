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
