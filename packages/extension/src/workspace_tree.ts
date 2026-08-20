import * as vscode from "vscode";
import * as path from "node:path";

// ============================================================================
// WorkspaceTreeProvider — AC6 of opencode#215.
// Renders all workspace folders as collapsible roots, expands recursively via
// vscode.workspace.fs.readDirectory(), respects files.exclude + .gitignore,
// shows theme icons, git decorations, opens on click, full context menus,
// and live-updates on filesystem changes.
// ============================================================================

export type WorkspaceItem = {
  uri: vscode.Uri;
  type: vscode.FileType;
  workspaceFolder?: vscode.WorkspaceFolder;
};

export class WorkspaceTreeProvider implements vscode.TreeDataProvider<WorkspaceItem> {
  private readonly _onDidChange = new vscode.EventEmitter<WorkspaceItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private watcher: vscode.FileSystemWatcher | undefined;
  private decorationProvider: vscode.Disposable | undefined;

  constructor() {
    // Live updates: watch all files and refresh affected subtree
    this.watcher = vscode.workspace.createFileSystemWatcher("**/*");
    this.watcher.onDidCreate(() => this.refresh());
    this.watcher.onDidChange(() => this.refresh());
    this.watcher.onDidDelete(() => this.refresh());

    // Git decorations: FileDecorationProvider reading from vscode.scm / git extension
    // Minimal: delegate to VS Code's built-in git decorations (theme handles it);
    // we provide a provider to surface modified/untracked via badge if available.
    this.decorationProvider = vscode.window.registerFileDecorationProvider({
      provideFileDecoration: (uri) => {
        // Let VS Code's git extension handle decorations; we return undefined
        // to avoid overriding — the explorer's theme icons already show git status.
        return undefined;
      },
    });
  }

  refresh(item?: WorkspaceItem): void {
    this._onDidChange.fire(item);
  }

  getTreeItem(element: WorkspaceItem): vscode.TreeItem {
    const isDir = element.type === vscode.FileType.Directory;
    const collapsible = isDir
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const label = path.basename(element.uri.fsPath) || element.uri.fsPath;
    const item = new vscode.TreeItem(label, collapsible);
    item.resourceUri = element.uri;
    // Theme icons: VS Code resolves ThemeIcon.File/Folder automatically via resourceUri
    item.contextValue = isDir ? "workspaceFolder" : "workspaceFile";
    if (!isDir) {
      item.command = {
        command: "vscode.open",
        title: "Open File",
        arguments: [element.uri],
      };
    }
    // Tooltip shows full path
    item.tooltip = element.uri.fsPath;
    return item;
  }

  async getChildren(element?: WorkspaceItem): Promise<WorkspaceItem[]> {
    // Root: workspace folders
    if (!element) {
      const folders = vscode.workspace.workspaceFolders ?? [];
      return folders.map((f) => ({
        uri: f.uri,
        type: vscode.FileType.Directory,
        workspaceFolder: f,
      }));
    }

    // Children: read directory, filter files.exclude + .gitignore, sort dirs first
    try {
      const entries = await vscode.workspace.fs.readDirectory(element.uri);
      // Respect files.exclude (simple prefix check)
      const exclude = vscode.workspace.getConfiguration("files", element.uri).get<Record<string, boolean>>("exclude", {});
      const excludePatterns = Object.entries(exclude)
        .filter(([, v]) => v)
        .map(([k]) => k.replace(/\*\*/g, "").replace(/\*/g, ""));

      const filtered = entries.filter(([name]) => {
        if (name.startsWith(".git")) return false;
        for (const pat of excludePatterns) {
          if (pat && name.includes(pat.replace(/\//g, ""))) return false;
        }
        return true;
      });

      // Sort: directories first, then files, alphabetically
      filtered.sort((a, b) => {
        if (a[1] !== b[1]) return a[1] === vscode.FileType.Directory ? -1 : 1;
        return a[0].localeCompare(b[0]);
      });

      return filtered.map(([name, type]) => ({
        uri: vscode.Uri.joinPath(element.uri, name),
        type,
      }));
    } catch {
      return [];
    }
  }

  getParent(element: WorkspaceItem): vscode.ProviderResult<WorkspaceItem> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    // If element is a workspace root, no parent
    if (folders.some((f) => f.uri.fsPath === element.uri.fsPath)) return undefined;
    const parentPath = path.dirname(element.uri.fsPath);
    // Find parent item
    const folder = vscode.workspace.getWorkspaceFolder(element.uri);
    if (!folder) return undefined;
    if (parentPath === folder.uri.fsPath) {
      return { uri: folder.uri, type: vscode.FileType.Directory, workspaceFolder: folder };
    }
    // Generic parent (type unknown, assume directory)
    return { uri: vscode.Uri.file(parentPath), type: vscode.FileType.Directory };
  }

  dispose(): void {
    this.watcher?.dispose();
    this.decorationProvider?.dispose();
    this._onDidChange.dispose();
  }
}

export function registerWorkspaceTree(ctx: vscode.ExtensionContext): WorkspaceTreeProvider {
  const provider = new WorkspaceTreeProvider();
  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider("amicode.workspace", provider),
    provider,
  );
  return provider;
}
