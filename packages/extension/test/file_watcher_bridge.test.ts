import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { FileWatcherBridge } from "../src/file_watcher_bridge";

// ---------------------------------------------------------------------------
// Helpers: intercept filesystem watcher callbacks by patching workspace
// ---------------------------------------------------------------------------
function patchWatcher() {
  const cbs: Record<string, Array<(uri: { fsPath: string }) => void>> = {
    create: [],
    change: [],
    delete: [],
  };
  const workspace = vscode.workspace as any;
  const origWatcher = workspace.createFileSystemWatcher;
  const origRelativePattern = (vscode as any).RelativePattern;
  (vscode as any).RelativePattern = class {
    constructor(_base: unknown, _pattern: string) {}
  };
  workspace.createFileSystemWatcher = () => ({
    onDidCreate: (cb: (uri: { fsPath: string }) => void) => {
      cbs.create.push(cb);
      return { dispose() {} };
    },
    onDidChange: (cb: (uri: { fsPath: string }) => void) => {
      cbs.change.push(cb);
      return { dispose() {} };
    },
    onDidDelete: (cb: (uri: { fsPath: string }) => void) => {
      cbs.delete.push(cb);
      return { dispose() {} };
    },
    dispose() {},
  });
  return {
    cbs,
    restore() {
      workspace.createFileSystemWatcher = origWatcher;
      (vscode as any).RelativePattern = origRelativePattern;
    },
  };
}

// ---------------------------------------------------------------------------
// Existing test: external descriptor invalidation (#976)
// ---------------------------------------------------------------------------
describe("FileWatcherBridge external descriptors (#976)", () => {
  afterEach(() => vi.useRealTimers());

  it("invalidates an opaque descriptor after debounce without exposing a path or client status", () => {
    vi.useFakeTimers();
    const { cbs, restore } = patchWatcher();
    try {
      const posted: unknown[] = [];
      const bridge = new FileWatcherBridge((message) => posted.push(message));
      bridge.updateExternalWatchSet([
        { file: "/outside/file.txt", reference: "external_1", revision: 7 },
      ]);

      cbs.change[0]({ fsPath: "/outside/file.txt" });
      vi.advanceTimersByTime(300);

      expect(posted).toEqual([
        {
          source: "amicode",
          kind: "assessed-diff-invalidate",
          reference: "external_1",
          revision: 7,
        },
      ]);
      bridge.dispose();
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// #1423: Revert open editor buffers on agent disk writes
// ---------------------------------------------------------------------------
describe("FileWatcherBridge buffer revert (#1423)", () => {
  let patch: ReturnType<typeof patchWatcher>;
  const workspace = vscode.workspace as any;
  const cmds = vscode.commands as any;

  beforeEach(() => {
    vi.useFakeTimers();
    patch = patchWatcher();
    cmds.executed = [];
    workspace.textDocuments = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    patch.restore();
    workspace.textDocuments = [];
  });

  it("reverts a non-dirty open buffer when the watched file changes on disk", async () => {
    workspace.textDocuments = [
      { uri: { fsPath: "/project/main.py" }, isDirty: false, save: vi.fn().mockResolvedValue(true) },
    ];
    const posted: unknown[] = [];
    const bridge = new FileWatcherBridge((msg) => posted.push(msg));
    bridge.updateWatchSet(["/project/main.py"]);

    // Simulate the filesystem watcher firing a "changed" event.
    patch.cbs.change[0]({ fsPath: "/project/main.py" });
    vi.advanceTimersByTime(300);
    // Allow the async revert to flush.
    await vi.advanceTimersByTimeAsync(0);

    expect(cmds.executed).toContain("workbench.action.files.revert");
    // The diff-invalidate webview message should still be posted.
    expect(posted).toEqual([
      expect.objectContaining({
        kind: "fs-diff-invalidate",
        file: "/project/main.py",
      }),
    ]);
    bridge.dispose();
  });

  it("does NOT revert a dirty buffer (user has unsaved edits)", async () => {
    workspace.textDocuments = [
      { uri: { fsPath: "/project/main.py" }, isDirty: true, save: vi.fn().mockResolvedValue(true) },
    ];
    const bridge = new FileWatcherBridge(() => {});
    bridge.updateWatchSet(["/project/main.py"]);

    patch.cbs.change[0]({ fsPath: "/project/main.py" });
    vi.advanceTimersByTime(300);
    await vi.advanceTimersByTimeAsync(0);

    expect(cmds.executed).not.toContain("workbench.action.files.revert");
    bridge.dispose();
  });

  it("does nothing if no editor tab is open for the changed file", async () => {
    workspace.textDocuments = []; // No open documents.
    const bridge = new FileWatcherBridge(() => {});
    bridge.updateWatchSet(["/project/main.py"]);

    patch.cbs.change[0]({ fsPath: "/project/main.py" });
    vi.advanceTimersByTime(300);
    await vi.advanceTimersByTimeAsync(0);

    expect(cmds.executed).not.toContain("workbench.action.files.revert");
    bridge.dispose();
  });

  it("does NOT revert on 'deleted' events (only 'changed' and 'created')", async () => {
    workspace.textDocuments = [
      { uri: { fsPath: "/project/main.py" }, isDirty: false, save: vi.fn().mockResolvedValue(true) },
    ];
    const bridge = new FileWatcherBridge(() => {});
    bridge.updateWatchSet(["/project/main.py"]);

    patch.cbs.delete[0]({ fsPath: "/project/main.py" });
    vi.advanceTimersByTime(300);
    await vi.advanceTimersByTimeAsync(0);

    expect(cmds.executed).not.toContain("workbench.action.files.revert");
    bridge.dispose();
  });
});

// ---------------------------------------------------------------------------
// #1424: LaTeX auto-recompile on agent .tex edits
// ---------------------------------------------------------------------------
describe("FileWatcherBridge LaTeX auto-recompile (#1424)", () => {
  let patch: ReturnType<typeof patchWatcher>;
  const workspace = vscode.workspace as any;
  const cmds = vscode.commands as any;

  beforeEach(() => {
    vi.useFakeTimers();
    patch = patchWatcher();
    cmds.executed = [];
    workspace.textDocuments = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    patch.restore();
    workspace.textDocuments = [];
  });

  it("triggers save after revert for .tex files so LaTeX Workshop recompiles", async () => {
    const saveMock = vi.fn().mockResolvedValue(true);
    workspace.textDocuments = [
      { uri: { fsPath: "/paper/main.tex" }, isDirty: false, save: saveMock },
    ];
    const bridge = new FileWatcherBridge(() => {});
    bridge.updateWatchSet(["/paper/main.tex"]);

    patch.cbs.change[0]({ fsPath: "/paper/main.tex" });
    vi.advanceTimersByTime(300);
    await vi.advanceTimersByTimeAsync(0);

    expect(cmds.executed).toContain("workbench.action.files.revert");
    expect(saveMock).toHaveBeenCalled();
    bridge.dispose();
  });

  it("triggers save after revert for .ltx files", async () => {
    const saveMock = vi.fn().mockResolvedValue(true);
    workspace.textDocuments = [
      { uri: { fsPath: "/paper/main.ltx" }, isDirty: false, save: saveMock },
    ];
    const bridge = new FileWatcherBridge(() => {});
    bridge.updateWatchSet(["/paper/main.ltx"]);

    patch.cbs.change[0]({ fsPath: "/paper/main.ltx" });
    vi.advanceTimersByTime(300);
    await vi.advanceTimersByTimeAsync(0);

    expect(cmds.executed).toContain("workbench.action.files.revert");
    expect(saveMock).toHaveBeenCalled();
    bridge.dispose();
  });

  it("does NOT trigger save for non-LaTeX files (.py, .jl, .md)", async () => {
    const saveMock = vi.fn().mockResolvedValue(true);
    workspace.textDocuments = [
      { uri: { fsPath: "/project/script.jl" }, isDirty: false, save: saveMock },
    ];
    const bridge = new FileWatcherBridge(() => {});
    bridge.updateWatchSet(["/project/script.jl"]);

    patch.cbs.change[0]({ fsPath: "/project/script.jl" });
    vi.advanceTimersByTime(300);
    await vi.advanceTimersByTimeAsync(0);

    // Buffer is reverted (non-dirty, non-LaTeX)...
    expect(cmds.executed).toContain("workbench.action.files.revert");
    // ...but NOT saved (no LaTeX Workshop hook to trigger).
    expect(saveMock).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it("does NOT trigger save for .tex if the buffer is dirty", async () => {
    const saveMock = vi.fn().mockResolvedValue(true);
    workspace.textDocuments = [
      { uri: { fsPath: "/paper/main.tex" }, isDirty: true, save: saveMock },
    ];
    const bridge = new FileWatcherBridge(() => {});
    bridge.updateWatchSet(["/paper/main.tex"]);

    patch.cbs.change[0]({ fsPath: "/paper/main.tex" });
    vi.advanceTimersByTime(300);
    await vi.advanceTimersByTimeAsync(0);

    // Dirty guard prevents both revert and save.
    expect(cmds.executed).not.toContain("workbench.action.files.revert");
    expect(saveMock).not.toHaveBeenCalled();
    bridge.dispose();
  });
});
