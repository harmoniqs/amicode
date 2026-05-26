// Minimal vscode API surface used by callback_server.ts / run_inspector.ts /
// file_watcher.ts. Used in isolation smoke tests only.

const calls = [];
export const __calls = calls;

const log = (kind, args) => calls.push({ kind, args });

export const window = {
  showInformationMessage: (...a) => { log("info", a); return Promise.resolve(undefined); },
  showWarningMessage:     (...a) => { log("warn", a); return Promise.resolve(undefined); },
  showErrorMessage:       (...a) => { log("error", a); return Promise.resolve(undefined); },
  showQuickPick:          (items, opts) => { log("quickPick", [items, opts]); return Promise.resolve(items[0]); },
  showTextDocument:       (uri, opts) => { log("openText", [uri, opts]); return Promise.resolve({}); },
  createOutputChannel:    (name) => ({
    appendLine: (s) => log("channel", [name, s]),
    append:     (s) => log("channel", [name, s]),
    dispose:    () => {},
  }),
};

export const commands = {
  executeCommand: (...a) => { log("cmd", a); return Promise.resolve(undefined); },
};

export const Uri = {
  file: (p) => ({ fsPath: p, toString: () => "file://" + p }),
};

export const ViewColumn = { Active: 1, Beside: 2 };

export class EventEmitter {
  constructor() { this.listeners = []; }
  get event() { return (l) => { this.listeners.push(l); return { dispose: () => {} }; }; }
  fire(v) { for (const l of this.listeners) try { l(v); } catch {} }
}

export default { window, commands, Uri, ViewColumn, EventEmitter };
