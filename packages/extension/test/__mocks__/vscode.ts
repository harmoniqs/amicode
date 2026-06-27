// Minimal `vscode` stub for unit tests (aliased in vitest.config.ts). Provides
// only the runtime members our node-side modules touch; types are erased at
// compile time so they need no runtime shape.
export const window = {
  showInformationMessage: () => Promise.resolve(undefined),
  showErrorMessage: () => Promise.resolve(undefined),
  showWarningMessage: () => Promise.resolve(undefined),
  createOutputChannel: () => ({ appendLine() {}, append() {}, dispose() {} }),
};
export const commands = { executeCommand: () => Promise.resolve(undefined) };
export const workspace = {
  workspaceFolders: [] as unknown[],
  getConfiguration: () => ({ get: (_k: string, d?: unknown) => d ?? "" }),
};
export const Uri = {
  file: (p: string) => ({ fsPath: p, toString: () => p }),
  joinPath: (base: { fsPath?: string } | string, ...parts: string[]) => {
    const root = typeof base === "string" ? base : base.fsPath ?? "";
    const full = [root, ...parts].join("/");
    return { fsPath: full, toString: () => full };
  },
};
export class EventEmitter {
  event = () => ({ dispose() {} });
  fire() {}
  dispose() {}
}
export class Disposable {
  dispose() {}
}
