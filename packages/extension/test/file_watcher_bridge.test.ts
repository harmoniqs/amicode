import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { FileWatcherBridge } from "../src/file_watcher_bridge";

describe("FileWatcherBridge external descriptors (#976)", () => {
  afterEach(() => vi.useRealTimers());

  it("invalidates an opaque descriptor after debounce without exposing a path or client status", () => {
    vi.useFakeTimers();
    const change: Array<(uri: { fsPath: string }) => void> = [];
    const workspace = vscode.workspace as any;
    const original = workspace.createFileSystemWatcher;
    const originalRelativePattern = (vscode as any).RelativePattern;
    (vscode as any).RelativePattern = class {
      constructor(_base: unknown, _pattern: string) {}
    };
    workspace.createFileSystemWatcher = () => ({
      onDidCreate: () => ({ dispose() {} }),
      onDidChange: (callback: (uri: { fsPath: string }) => void) => { change.push(callback); return { dispose() {} }; },
      onDidDelete: () => ({ dispose() {} }),
      dispose() {},
    });
    try {
      const posted: unknown[] = [];
      const bridge = new FileWatcherBridge((message) => posted.push(message));
      bridge.updateExternalWatchSet([{ file: "/outside/file.txt", reference: "external_1", revision: 7 }]);

      change[0]({ fsPath: "/outside/file.txt" });
      vi.advanceTimersByTime(300);

      expect(posted).toEqual([{
        source: "amicode",
        kind: "assessed-diff-invalidate",
        reference: "external_1",
        revision: 7,
      }]);
      bridge.dispose();
    } finally {
      workspace.createFileSystemWatcher = original;
      (vscode as any).RelativePattern = originalRelativePattern;
    }
  });
});
