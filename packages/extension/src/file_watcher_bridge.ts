import * as vscode from "vscode";
import * as path from "node:path";

// ============================================================================
// FileWatcherBridge — per-session targeted file watcher (#844)
//
// Watches every file the session has touched, regardless of its location on
// disk (in-project or cross-project). Uses VS Code's FileSystemWatcher with
// RelativePattern(dir, '*') per parent directory, filtering events against the
// watched file set. When a watched file changes, it posts an
// `fs-diff-invalidate` message to the chat panel's webview.
//
// The watch set is idempotent: calling updateWatchSet() with a new set of
// paths replaces the previous set, adding watchers for new directories and
// disposing watchers for directories no longer needed.
// ============================================================================

interface FsInvalidateMessage {
  source: "amicode";
  kind: "fs-diff-invalidate";
  file: string;
  /** "created" | "changed" | "deleted" */
  changeType: string;
}

/** Server-assessed watch state stays in the extension host; paths never relay. */
export interface ExternalWatchDescriptor {
  file: string;
  reference: string;
  revision: number;
}

interface AssessedInvalidateMessage {
  source: "amicode";
  kind: "assessed-diff-invalidate";
  reference: string;
  revision: number;
}

export class FileWatcherBridge implements vscode.Disposable {
  /** One watcher per parent directory. */
  private readonly dirWatchers = new Map<string, vscode.FileSystemWatcher>();
  /** The set of absolute file paths we're interested in. */
  private watchedFiles = new Set<string>();
  /** Canonical server descriptors keyed by host-only file path. */
  private externalWatchedFiles = new Map<string, ExternalWatchDescriptor>();
  /** Per-file debounce timers (300ms). */
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(private readonly postMessage: (msg: FsInvalidateMessage | AssessedInvalidateMessage) => void) {}

  /**
   * Replace the watched file set. Adds watchers for new directories and
   * disposes watchers for directories that no longer have any watched files.
   * Idempotent: calling with the same set is a no-op.
   */
  updateWatchSet(absolutePaths: string[]): void {
    if (this.disposed) return;

    this.watchedFiles = new Set(absolutePaths);

    // Group files by parent directory
    this.refreshDirectoryWatchers();
  }

  /** Replace externally assessed descriptors; legacy path watching is untouched. */
  updateExternalWatchSet(descriptors: ExternalWatchDescriptor[]): void {
    if (this.disposed) return;
    this.externalWatchedFiles = new Map(descriptors.map((descriptor) => [descriptor.file, descriptor]));
    this.refreshDirectoryWatchers();
  }

  private refreshDirectoryWatchers(): void {
    const nextDirs = new Set<string>();
    for (const file of this.watchedFiles) nextDirs.add(path.dirname(file));
    for (const file of this.externalWatchedFiles.keys()) nextDirs.add(path.dirname(file));

    // Add watchers for new directories
    for (const dir of nextDirs) {
      if (!this.dirWatchers.has(dir)) {
        this.addDirWatcher(dir);
      }
    }

    // Remove watchers for directories no longer needed
    const staleDirs: string[] = [];
    this.dirWatchers.forEach((_watcher, dir) => {
      if (!nextDirs.has(dir)) staleDirs.push(dir);
    });
    for (const dir of staleDirs) {
      this.dirWatchers.get(dir)?.dispose();
      this.dirWatchers.delete(dir);
    }
  }

  private addDirWatcher(dir: string): void {
    try {
      const pattern = new vscode.RelativePattern(vscode.Uri.file(dir), "*");
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidCreate((uri) => this.onFsEvent(uri, "created"));
      watcher.onDidChange((uri) => this.onFsEvent(uri, "changed"));
      watcher.onDidDelete((uri) => this.onFsEvent(uri, "deleted"));
      this.dirWatchers.set(dir, watcher);
    } catch {
      // If directory doesn't exist or can't be watched, skip silently.
    }
  }

  private onFsEvent(uri: vscode.Uri, changeType: string): void {
    const filePath = uri.fsPath;
    const external = this.externalWatchedFiles.get(filePath);
    if (!external && !this.watchedFiles.has(filePath)) return;

    // Debounce per file (300ms)
    const key = external ? `external:${filePath}` : filePath;
    const existing = this.debounceTimers.get(key);
    if (existing !== undefined) clearTimeout(existing);

    this.debounceTimers.set(
      key,
      setTimeout(() => {
        this.debounceTimers.delete(key);
        if (this.disposed) return;
        if (external) {
          this.postMessage({
            source: "amicode",
            kind: "assessed-diff-invalidate",
            reference: external.reference,
            revision: external.revision,
          });
          return;
        }
        this.postMessage({
          source: "amicode",
          kind: "fs-diff-invalidate",
          file: filePath,
          changeType,
        });
      }, 300),
    );
  }

  dispose(): void {
    this.disposed = true;
    this.dirWatchers.forEach((watcher) => watcher.dispose());
    this.dirWatchers.clear();
    this.debounceTimers.forEach((timer) => clearTimeout(timer));
    this.debounceTimers.clear();
    this.watchedFiles.clear();
    this.externalWatchedFiles.clear();
  }
}
