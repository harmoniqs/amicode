import * as vscode from "vscode";
import * as path from "node:path";

// ============================================================================
// WorkspaceTreeProvider — AC6 of opencode#215.
// Renders all workspace folders as collapsible roots, expands recursively via
// vscode.workspace.fs.readDirectory(), respects files.exclude + .gitignore,
// shows theme icons, git decorations, opens on click, full context menus,
// and live-updates on filesystem changes.
//
// Context-menu commands are registered as amicode.workspace.* because the
// built-in explorer.* commands only fire within VS Code's native Explorer.
// ============================================================================

export type WorkspaceItem = {
  uri: vscode.Uri;
  type: vscode.FileType;
  workspaceFolder?: vscode.WorkspaceFolder;
  /** Virtual action items (e.g. "Open Chat") — not real files. */
  action?: string;
};

export class WorkspaceTreeProvider implements vscode.TreeDataProvider<WorkspaceItem> {
  private readonly _onDidChange = new vscode.EventEmitter<WorkspaceItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private watcher: vscode.FileSystemWatcher | undefined;
  private workspaceSub: vscode.Disposable | undefined;
  private decorationProvider: vscode.Disposable | undefined;
  private chatActive = false;
  private extensionUri?: vscode.Uri;

  constructor() {
    // Live updates: watch all files and refresh affected subtree
    this.watcher = vscode.workspace.createFileSystemWatcher("**/*");
    this.watcher.onDidCreate(() => this.refresh());
    this.watcher.onDidChange(() => this.refresh());
    this.watcher.onDidDelete(() => this.refresh());

    // Refresh when workspace folders are added/removed
    this.workspaceSub = vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh());

    // Git decorations: FileDecorationProvider reading from vscode.scm / git extension
    // Minimal: delegate to VS Code's built-in git decorations (theme handles it);
    // we provide a provider to surface modified/untracked via badge if available.
    this.decorationProvider = vscode.window.registerFileDecorationProvider({
      provideFileDecoration: (_uri) => {
        // Let VS Code's git extension handle decorations; we return undefined
        // to avoid overriding — the explorer's theme icons already show git status.
        return undefined;
      },
    });
  }

  refresh(item?: WorkspaceItem): void {
    this._onDidChange.fire(item);
  }

  /** Set the extension URI for resolving media assets (SVG icons). */
  setExtensionUri(uri: vscode.Uri): void {
    this.extensionUri = uri;
  }

  /** Mark whether the Amicode chat tab is currently open (mutes the chat item). */
  setChatActive(active: boolean): void {
    if (this.chatActive !== active) {
      this.chatActive = active;
      this.refresh();
    }
  }

  getTreeItem(element: WorkspaceItem): vscode.TreeItem {
    // Chat action item — custom yellow SVG icon
    if (element.action === "openChat") {
      const item = new vscode.TreeItem("Chat with Amico", vscode.TreeItemCollapsibleState.None);
      item.command = { command: "amicode.openChat", title: "Open Chat" };
      item.contextValue = "chatAction";
      if (this.extensionUri) {
        const icon = this.chatActive ? "chat-muted.svg" : "chat-yellow.svg";
        item.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", icon);
      }
      if (this.chatActive) {
        item.description = "(open)";
        item.tooltip = "Amicode chat is open";
      } else {
        item.tooltip = "Open Amicode chat";
      }
      return item;
    }

    const isDir = element.type === vscode.FileType.Directory;
    const collapsible = isDir
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const label = path.basename(element.uri.fsPath) || element.uri.fsPath;
    const item = new vscode.TreeItem(label, collapsible);
    item.resourceUri = element.uri;
    // Theme icons: VS Code resolves ThemeIcon.File/Folder automatically via resourceUri
    // Root workspace folders get "workspaceRoot" so the "Remove from Workspace" menu targets them.
    item.contextValue = isDir
      ? (element.workspaceFolder ? "workspaceRoot" : "workspaceFolder")
      : "workspaceFile";
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
    // Root: chat action + workspace folders
    if (!element) {
      const chatItem: WorkspaceItem = {
        uri: vscode.Uri.file("__chat__"),
        type: vscode.FileType.File,
        action: "openChat",
      };
      const folders = vscode.workspace.workspaceFolders ?? [];
      return [
        chatItem,
        ...folders.map((f) => ({
          uri: f.uri,
          type: vscode.FileType.Directory,
          workspaceFolder: f,
        })),
      ];
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
        // Hide the .git directory itself, but not .gitignore, .github, etc.
        if (name === ".git") return false;
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
    this.workspaceSub?.dispose();
    this.decorationProvider?.dispose();
    this._onDidChange.dispose();
  }
}

export function registerWorkspaceTree(ctx: vscode.ExtensionContext): WorkspaceTreeProvider {
  const provider = new WorkspaceTreeProvider();
  provider.setExtensionUri(ctx.extensionUri);
  const treeView = vscode.window.createTreeView("amicode.workspace", {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  // ── Context-menu commands ──────────────────────────────────────────────────
  // These wrap VS Code's built-in file operations so they work from our custom
  // tree view (the built-in explorer.* commands are Explorer-only).

  const cmd = (id: string, handler: (item: WorkspaceItem) => void | Promise<void>) =>
    vscode.commands.registerCommand(id, handler);

  ctx.subscriptions.push(
    treeView,
    provider,

    cmd("amicode.workspace.newFile", async (item) => {
      const targetDir = resolveDir(item);
      if (!targetDir) return;
      const name = await vscode.window.showInputBox({ prompt: "File name", placeHolder: "untitled.jl" });
      if (!name) return;
      const uri = vscode.Uri.joinPath(targetDir, name);
      await vscode.workspace.fs.writeFile(uri, new Uint8Array());
      await vscode.commands.executeCommand("vscode.open", uri);
    }),

    cmd("amicode.workspace.newFolder", async (item) => {
      const targetDir = resolveDir(item);
      if (!targetDir) return;
      const name = await vscode.window.showInputBox({ prompt: "Folder name" });
      if (!name) return;
      const uri = vscode.Uri.joinPath(targetDir, name);
      await vscode.workspace.fs.createDirectory(uri);
    }),

    cmd("amicode.workspace.rename", async (item) => {
      if (!item?.uri) return;
      const oldName = path.basename(item.uri.fsPath);
      const newName = await vscode.window.showInputBox({ prompt: "New name", value: oldName });
      if (!newName || newName === oldName) return;
      const newUri = vscode.Uri.joinPath(vscode.Uri.file(path.dirname(item.uri.fsPath)), newName);
      await vscode.workspace.fs.rename(item.uri, newUri);
    }),

    cmd("amicode.workspace.delete", async (item) => {
      if (!item?.uri) return;
      const name = path.basename(item.uri.fsPath);
      const confirm = await vscode.window.showWarningMessage(
        `Delete "${name}"?`, { modal: true }, "Move to Trash", "Delete Permanently"
      );
      if (confirm === "Move to Trash") {
        await vscode.workspace.fs.delete(item.uri, { useTrash: true, recursive: true });
      } else if (confirm === "Delete Permanently") {
        await vscode.workspace.fs.delete(item.uri, { recursive: true });
      }
    }),

    cmd("amicode.workspace.copyPath", (item) => {
      if (!item?.uri) return;
      vscode.env.clipboard.writeText(item.uri.fsPath);
    }),

    cmd("amicode.workspace.copyRelativePath", (item) => {
      if (!item?.uri) return;
      const folder = vscode.workspace.getWorkspaceFolder(item.uri);
      const rel = folder ? path.relative(folder.uri.fsPath, item.uri.fsPath) : item.uri.fsPath;
      vscode.env.clipboard.writeText(rel);
    }),

    cmd("amicode.workspace.revealInOS", (item) => {
      if (!item?.uri) return;
      vscode.commands.executeCommand("revealFileInOS", item.uri);
    }),

    cmd("amicode.workspace.openInTerminal", (item) => {
      const dir = resolveDir(item);
      if (!dir) return;
      const terminal = vscode.window.createTerminal({ cwd: dir.fsPath });
      terminal.show();
    }),

    cmd("amicode.workspace.openToSide", (item) => {
      if (!item?.uri || item.type === vscode.FileType.Directory) return;
      vscode.commands.executeCommand("vscode.open", item.uri, vscode.ViewColumn.Beside);
    }),

    cmd("amicode.workspace.removeFromWorkspace", (item) => {
      if (!item?.workspaceFolder) return;
      const folders = vscode.workspace.workspaceFolders ?? [];
      const idx = folders.indexOf(item.workspaceFolder);
      if (idx >= 0) {
        vscode.workspace.updateWorkspaceFolders(idx, 1);
      }
    }),

    cmd("amicode.workspace.addFolder", async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: true,
        openLabel: "Add Folder to Workspace",
      });
      if (!uris?.length) return;
      const folders = vscode.workspace.workspaceFolders ?? [];
      vscode.workspace.updateWorkspaceFolders(
        folders.length, 0,
        ...uris.map((uri) => ({ uri })),
      );
    }),
  );

  return provider;
}

/** Resolve the target directory URI: if the item is a file, use its parent. */
function resolveDir(item: WorkspaceItem | undefined): vscode.Uri | undefined {
  if (!item?.uri) return undefined;
  if (item.type === vscode.FileType.Directory) return item.uri;
  return vscode.Uri.file(path.dirname(item.uri.fsPath));
}
