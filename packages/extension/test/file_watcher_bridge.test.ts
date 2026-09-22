import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import * as fs from "node:fs";
import { FileWatcherBridge } from "../src/file_watcher_bridge";

// Mock fs.readFileSync so we control what "disk content" the bridge sees.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, readFileSync: vi.fn(() => "disk content") };
});

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

/** Create a mock TextDocument with controllable content, dirty state, and save. */
function mockDoc(fsPath: string, opts: { isDirty?: boolean; content?: string } = {}) {
  return {
    uri: { fsPath },
    isDirty: opts.isDirty ?? false,
    getText: () => opts.content ?? "stale buffer content",
    positionAt: (offset: number) => ({ line: 0, character: offset }),
    save: vi.fn().mockResolvedValue(true),
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
// #1423: Sync open editor buffers on agent disk writes
// ---------------------------------------------------------------------------
describe("FileWatcherBridge buffer sync (#1423)", () => {
  let patch: ReturnType<typeof patchWatcher>;
  const workspace = vscode.workspace as any;

  beforeEach(() => {
    vi.useFakeTimers();
    patch = patchWatcher();
    workspace.textDocuments = [];
    workspace.appliedEdits = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    patch.restore();
    workspace.textDocuments = [];
    workspace.appliedEdits = [];
  });

  it("applies a WorkspaceEdit to sync a non-dirty buffer with disk content", async () => {
    const doc = mockDoc("/project/main.py");
    workspace.textDocuments = [doc];
    const posted: unknown[] = [];
    const bridge = new FileWatcherBridge((msg) => posted.push(msg));
    bridge.updateWatchSet(["/project/main.py"]);

    patch.cbs.change[0]({ fsPath: "/project/main.py" });
    vi.advanceTimersByTime(300);
    await vi.advanceTimersByTimeAsync(0);

    // WorkspaceEdit was applied (buffer synced with disk).
    expect(workspace.appliedEdits.length).toBe(1);
    // doc.save() was called to clear the dirty flag from the edit.
    expect(doc.save).toHaveBeenCalled();
    // The diff-invalidate webview message should still be posted.
    expect(posted).toEqual([
      expect.objectContaining({
        kind: "fs-diff-invalidate",
        file: "/project/main.py",
      }),
    ]);
    bridge.dispose();
  });

  it("does NOT sync a dirty buffer (user has unsaved edits)", async () => {
    const doc = mockDoc("/project/main.py", { isDirty: true });
    workspace.textDocuments = [doc];
    const bridge = new FileWatcherBridge(() => {});
    bridge.updateWatchSet(["/project/main.py"]);

    patch.cbs.change[0]({ fsPath: "/project/main.py" });
    vi.advanceTimersByTime(300);
    await vi.advanceTimersByTimeAsync(0);

    expect(workspace.appliedEdits.length).toBe(0);
    expect(doc.save).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it("does nothing if no editor tab is open for the changed file", async () => {
    workspace.textDocuments = [];
    const bridge = new FileWatcherBridge(() => {});
    bridge.updateWatchSet(["/project/main.py"]);

    patch.cbs.change[0]({ fsPath: "/project/main.py" });
    vi.advanceTimersByTime(300);
    await vi.advanceTimersByTimeAsync(0);

    expect(workspace.appliedEdits.length).toBe(0);
    bridge.dispose();
  });

  it("does NOT sync on 'deleted' events (only 'changed' and 'created')", async () => {
    const doc = mockDoc("/project/main.py");
    workspace.textDocuments = [doc];
    const bridge = new FileWatcherBridge(() => {});
    bridge.updateWatchSet(["/project/main.py"]);

    patch.cbs.delete[0]({ fsPath: "/project/main.py" });
    vi.advanceTimersByTime(300);
    await vi.advanceTimersByTimeAsync(0);

    expect(workspace.appliedEdits.length).toBe(0);
    expect(doc.save).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it("skips sync when disk content matches buffer content", async () => {
    // Make disk content match what the buffer returns.
    vi.mocked(fs.readFileSync).mockReturnValueOnce("same content");
    const doc = mockDoc("/project/main.py", { content: "same content" });
    workspace.textDocuments = [doc];
    const bridge = new FileWatcherBridge(() => {});
    bridge.updateWatchSet(["/project/main.py"]);

    patch.cbs.change[0]({ fsPath: "/project/main.py" });
    vi.advanceTimersByTime(300);
    await vi.advanceTimersByTimeAsync(0);

    // No edit needed — content is already in sync.
    expect(workspace.appliedEdits.length).toBe(0);
    expect(doc.save).not.toHaveBeenCalled();
    bridge.dispose();
  });
});

// ---------------------------------------------------------------------------
// #1424: LaTeX auto-recompile on agent .tex edits
// ---------------------------------------------------------------------------
describe("FileWatcherBridge LaTeX auto-recompile (#1424)", () => {
  let patch: ReturnType<typeof patchWatcher>;
  const workspace = vscode.workspace as any;

  beforeEach(() => {
    vi.useFakeTimers();
    patch = patchWatcher();
    workspace.textDocuments = [];
    workspace.appliedEdits = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    patch.restore();
    workspace.textDocuments = [];
    workspace.appliedEdits = [];
  });

  it("calls save after sync for .tex files (triggers LaTeX Workshop)", async () => {
    const doc = mockDoc("/paper/main.tex");
    workspace.textDocuments = [doc];
    const bridge = new FileWatcherBridge(() => {});
    bridge.updateWatchSet(["/paper/main.tex"]);

    patch.cbs.change[0]({ fsPath: "/paper/main.tex" });
    vi.advanceTimersByTime(300);
    await vi.advanceTimersByTimeAsync(0);

    expect(workspace.appliedEdits.length).toBe(1);
    expect(doc.save).toHaveBeenCalled();
    bridge.dispose();
  });

  it("calls save after sync for .ltx files", async () => {
    const doc = mockDoc("/paper/main.ltx");
    workspace.textDocuments = [doc];
    const bridge = new FileWatcherBridge(() => {});
    bridge.updateWatchSet(["/paper/main.ltx"]);

    patch.cbs.change[0]({ fsPath: "/paper/main.ltx" });
    vi.advanceTimersByTime(300);
    await vi.advanceTimersByTimeAsync(0);

    expect(workspace.appliedEdits.length).toBe(1);
    expect(doc.save).toHaveBeenCalled();
    bridge.dispose();
  });

  it("calls save for non-LaTeX files too (clears dirty flag from the edit)", async () => {
    // The syncOpenBuffer always saves after applying the edit to clear the
    // dirty state. The LaTeX-specific behavior is that this save ALSO kicks
    // LaTeX Workshop, but the save itself is universal.
    const doc = mockDoc("/project/script.jl");
    workspace.textDocuments = [doc];
    const bridge = new FileWatcherBridge(() => {});
    bridge.updateWatchSet(["/project/script.jl"]);

    patch.cbs.change[0]({ fsPath: "/project/script.jl" });
    vi.advanceTimersByTime(300);
    await vi.advanceTimersByTimeAsync(0);

    expect(workspace.appliedEdits.length).toBe(1);
    expect(doc.save).toHaveBeenCalled();
    bridge.dispose();
  });

  it("does NOT save when the buffer-sync edit is rejected (applyEdit → false)", async () => {
    // #1414: a WorkspaceEdit can be rejected if the document version advanced
    // between the disk read and the apply. Saving anyway would persist a
    // half-applied / stale buffer — only save after a successful edit.
    const doc = mockDoc("/paper/main.tex");
    workspace.textDocuments = [doc];
    const origApplyEdit = workspace.applyEdit;
    workspace.applyEdit = () => Promise.resolve(false);
    try {
      const bridge = new FileWatcherBridge(() => {});
      bridge.updateWatchSet(["/paper/main.tex"]);

      patch.cbs.change[0]({ fsPath: "/paper/main.tex" });
      vi.advanceTimersByTime(300);
      await vi.advanceTimersByTimeAsync(0);

      expect(doc.save).not.toHaveBeenCalled();
      bridge.dispose();
    } finally {
      workspace.applyEdit = origApplyEdit;
    }
  });

  it("does NOT sync or save for .tex if the buffer is dirty", async () => {
    const doc = mockDoc("/paper/main.tex", { isDirty: true });
    workspace.textDocuments = [doc];
    const bridge = new FileWatcherBridge(() => {});
    bridge.updateWatchSet(["/paper/main.tex"]);

    patch.cbs.change[0]({ fsPath: "/paper/main.tex" });
    vi.advanceTimersByTime(300);
    await vi.advanceTimersByTimeAsync(0);

    expect(workspace.appliedEdits.length).toBe(0);
    expect(doc.save).not.toHaveBeenCalled();
    bridge.dispose();
  });
});
