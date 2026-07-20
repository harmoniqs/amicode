// Minimal `vscode` stub for unit tests (aliased in vitest.config.ts). Provides
// only the runtime members our node-side modules touch; types are erased at
// compile time so they need no runtime shape.
export const window = {
  showInformationMessage: () => Promise.resolve(undefined),
  showErrorMessage: () => Promise.resolve(undefined),
  showWarningMessage: () => Promise.resolve(undefined),
  showInputBox: () => Promise.resolve(undefined),
  createOutputChannel: () => ({ appendLine() {}, append() {}, dispose() {} }),
  registerWebviewViewProvider: () => ({ dispose() {} }),
  activeColorTheme: { kind: 2 }, // ColorThemeKind.Dark
  onDidChangeActiveColorTheme: (_cb: unknown, _thisArg?: unknown, _subs?: unknown) => ({ dispose() {} }),
  createWebviewPanel: (_viewType: string, _title: string, _column?: unknown, _opts?: unknown) => {
    const disposeCbs: Array<() => void> = [];
    return {
      webview: {
        html: "",
        cspSource: "test:",
        asWebviewUri: (u: unknown) => u,
        onDidReceiveMessage: () => ({ dispose() {} }),
      },
      revealCount: 0,
      reveal() {
        this.revealCount += 1;
      },
      onDidDispose(cb: () => void, _thisArg?: unknown, _subs?: unknown) {
        disposeCbs.push(cb);
        return { dispose() {} };
      },
      dispose() {
        for (const cb of disposeCbs) cb();
      },
    };
  },
};
const registeredCommands = new Map<string, (...a: unknown[]) => unknown>();
export const commands = {
  registerCommand: (id: string, fn: (...a: unknown[]) => unknown) => {
    registeredCommands.set(id, fn);
    return {
      dispose() {
        registeredCommands.delete(id);
      },
    };
  },
  executeCommand: (id: string, ...a: unknown[]) => Promise.resolve(registeredCommands.get(id)?.(...a)),
};
export const ViewColumn = { One: 1, Two: 2 };
export const ColorThemeKind = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 };
export const workspace = {
  workspaceFolders: [] as unknown[],
  getConfiguration: () => ({ get: (_k: string, d?: unknown) => d ?? "" }),
};
export const Uri = {
  file: (p: string) => ({ fsPath: p, toString: () => p }),
  joinPath: (base: { fsPath?: string } | string, ...parts: string[]) => {
    const root = typeof base === "string" ? base : (base.fsPath ?? "");
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
export class TreeItem {
  description?: string;
  tooltip?: string;
  command?: unknown;
  constructor(
    public label: string,
    public collapsibleState?: number,
  ) {}
}
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
