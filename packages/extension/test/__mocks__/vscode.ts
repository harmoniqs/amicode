// Minimal `vscode` stub for unit tests (aliased in vitest.config.ts). Provides
// only the runtime members our node-side modules touch; types are erased at
// compile time so they need no runtime shape.
export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
export const window = {
  showInformationMessage: () => Promise.resolve(undefined),
  showErrorMessage: () => Promise.resolve(undefined),
  showWarningMessage: () => Promise.resolve(undefined),
  showInputBox: () => Promise.resolve(undefined),
  showSaveDialog: () => Promise.resolve(undefined),
  showOpenDialog: () => Promise.resolve(undefined),
  createOutputChannel: () => ({
    appendLine() {},
    append() {},
    dispose() {},
  }),
  registerWebviewViewProvider: () => ({ dispose() {} }),
  registerFileDecorationProvider: () => ({ dispose() {} }),
  createTreeView: (_id: string, _opts?: unknown) => ({
    dispose() {},
    onDidChangeSelection: () => ({ dispose() {} }),
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidExpandElement: () => ({ dispose() {} }),
    onDidCollapseElement: () => ({ dispose() {} }),
  }),
  createTerminal: (_opts?: unknown) => ({
    show() {},
    sendText() {},
    dispose() {},
    _opts,
  }),
  activeColorTheme: { kind: 2 }, // ColorThemeKind.Dark
  onDidChangeActiveColorTheme: (_cb: unknown, _thisArg?: unknown, _subs?: unknown) => ({ dispose() {} }),
   createWebviewPanel: (_viewType: string, _title: string, _column?: unknown, _opts?: unknown) => {
    const disposeCbs: Array<() => void> = [];
    const messageCbs: Array<(msg: unknown) => void> = [];
    const viewStateCbs: Array<(e: unknown) => void> = [];
    const panel = {
      visible: true,
      active: true,
      webview: {
        html: "",
        cspSource: "test:",
        asWebviewUri: (u: unknown) => u,
        onDidReceiveMessage: (cb: (msg: unknown) => void, _thisArg?: unknown, _subs?: unknown) => {
          messageCbs.push(cb);
          return { dispose() {} };
        },
        postMessage: () => Promise.resolve(true),
        _simulateMessage(msg: unknown) { for (const cb of messageCbs) cb(msg); },
      },
      revealCount: 0,
      reveal() {
        this.revealCount += 1;
      },
      onDidDispose(cb: () => void, _thisArg?: unknown, _subs?: unknown) {
        disposeCbs.push(cb);
        return { dispose() {} };
      },
      onDidChangeViewState(cb: (e: unknown) => void, _thisArg?: unknown, _subs?: unknown) {
        viewStateCbs.push(cb);
        return { dispose() {} };
      },
      _simulateViewState(active: boolean, visible: boolean) {
        panel.active = active;
        panel.visible = visible;
        for (const cb of viewStateCbs) cb({ webviewPanel: panel });
      },
      dispose() {
        for (const cb of disposeCbs) cb();
      },
    };
    return panel;
  },
};
const registeredCommands = new Map<string, (...a: unknown[]) => unknown>();
export const commands = {
  executed: [] as string[],
  registerCommand: (id: string, fn: (...a: unknown[]) => unknown) => {
    registeredCommands.set(id, fn);
    return {
      dispose() {
        registeredCommands.delete(id);
      },
    };
  },
  executeCommand: (id: string, ...a: unknown[]) => {
    commands.executed.push(id);
    return Promise.resolve(registeredCommands.get(id)?.(...a));
  },
};
export const ViewColumn = { One: 1, Two: 2, Beside: -2 };
export const ColorThemeKind = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 };
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
export const env = {
  opened: [] as unknown[],
  openExternal: (u: unknown) => {
    env.opened.push(u);
    return Promise.resolve(true);
  },
  clipboard: {
    text: "",
    readText(): Promise<string> {
      return Promise.resolve(env.clipboard.text);
    },
    writeText(t: string): Promise<void> {
      env.clipboard.text = t;
      return Promise.resolve();
    },
  },
};
export const extensions = {
  all: [] as unknown[],
  getExtension: (_id: string): unknown => undefined,
};
export const workspace = {
  workspaceFolders: [] as unknown[],
  configUpdates: [] as Array<[string, unknown]>,
  getConfiguration: () => ({
    get: (_k: string, d?: unknown) => d ?? "",
    update: (k: string, v: unknown) => {
      workspace.configUpdates.push([k, v]);
      return Promise.resolve();
    },
  }),
  getWorkspaceFolder: (uri: { fsPath: string }) => {
    return workspace.workspaceFolders.find(
      (f: any) => uri.fsPath.startsWith(f.uri.fsPath)
    ) ?? undefined;
  },
  createFileSystemWatcher: () => ({
    onDidCreate: () => ({ dispose() {} }),
    onDidChange: () => ({ dispose() {} }),
    onDidDelete: () => ({ dispose() {} }),
    dispose() {},
  }),
  updateWorkspaceFolders: (_start: number, _deleteCount: number | null, ..._adds: unknown[]) => true,
  _workspaceFoldersCbs: [] as Array<() => void>,
  onDidChangeWorkspaceFolders: (cb: () => void, _thisArg?: unknown, _subs?: unknown) => {
    (workspace as any)._workspaceFoldersCbs.push(cb);
    return { dispose() {} };
  },
  _fireWorkspaceFoldersChange() {
    for (const cb of (workspace as any)._workspaceFoldersCbs) cb();
  },
  fs: {
    writeFile: (_u: unknown, _b: unknown) => Promise.resolve(),
    readDirectory: (_u: unknown): Promise<Array<[string, number]>> => Promise.resolve([]),
    createDirectory: (_u: unknown) => Promise.resolve(),
    delete: (_u: unknown, _opts?: unknown) => Promise.resolve(),
    rename: (_old: unknown, _new: unknown) => Promise.resolve(),
  },
};
export const Uri = {
  file: (p: string) => ({ fsPath: p, toString: () => p }),
  parse: (s: string) => ({ fsPath: s, toString: () => s }),
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
  resourceUri?: unknown;
  contextValue?: string;
  iconPath?: unknown;
  constructor(
    public label: string,
    public collapsibleState?: number,
  ) {}
}
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
export class ThemeIcon {
  constructor(public id: string, public color?: unknown) {}
}
export class ThemeColor {
  constructor(public id: string) {}
}
