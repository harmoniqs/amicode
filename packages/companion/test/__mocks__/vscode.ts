// Minimal `vscode` stub for the companion's unit tests (aliased in
// vitest.config.ts). Provides only the runtime members src/companion.ts touches;
// types are erased at compile time. Trimmed from the main extension's richer mock
// (packages/extension/test/__mocks__/vscode.ts) to the companion's tiny surface.

const registeredCommands = new Map<string, (...a: unknown[]) => unknown>();
export const commands = {
  executed: [] as Array<{ id: string; args: unknown[] }>,
  registerCommand: (id: string, fn: (...a: unknown[]) => unknown) => {
    registeredCommands.set(id, fn);
    return {
      dispose() {
        registeredCommands.delete(id);
      },
    };
  },
  executeCommand: (id: string, ...args: unknown[]) => {
    commands.executed.push({ id, args });
    return Promise.resolve(registeredCommands.get(id)?.(...args));
  },
  // Test-only introspection (not part of the real vscode API):
  _registeredIds: () => Array.from(registeredCommands.keys()),
  _get: (id: string) => registeredCommands.get(id),
  _reset: () => {
    registeredCommands.clear();
    commands.executed.length = 0;
  },
};

export const window = {
  messages: { error: [] as string[], info: [] as string[], warn: [] as string[] },
  showErrorMessage: (m: string) => {
    window.messages.error.push(m);
    return Promise.resolve(undefined);
  },
  showInformationMessage: (m: string) => {
    window.messages.info.push(m);
    return Promise.resolve(undefined);
  },
  showWarningMessage: (m: string) => {
    window.messages.warn.push(m);
    return Promise.resolve(undefined);
  },
};

export const env = {
  // The window's remote indicator: an "ssh-remote…" string when the window is
  // connected to Remote-SSH, undefined when local. Tests set it to exercise the
  // companion's direction inference (remote → reopen local; local → reopen remote).
  remoteName: undefined as string | undefined,
};

export const workspace = {
  _config: {} as Record<string, unknown>,
  // The open text documents — the dirty-editor guard (#1276) reads `.isDirty`.
  // Empty by default; tests push `{ isDirty: true }` to exercise the guard.
  textDocuments: [] as Array<{ isDirty: boolean }>,
  getConfiguration: () => ({
    get: (k: string, d?: unknown) => (k in workspace._config ? workspace._config[k] : (d ?? "")),
  }),
};

export const Uri = {
  parse: (s: string) => ({ fsPath: s, scheme: s.split(":")[0], toString: () => s }),
  file: (p: string) => ({ fsPath: p, scheme: "file", toString: () => `file://${p}` }),
};

export class Disposable {
  dispose() {}
}
