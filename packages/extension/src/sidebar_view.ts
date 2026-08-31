// sidebar_view.ts — WebviewViewProvider for the Amicode sidebar (#673).
//
// Replaces the native TreeDataProvider (workspace_tree.ts) with a webview that
// can render custom UI: styled buttons, project metadata, lifecycle pills, and
// eventually a fleet section. The sidebar is navigation chrome — destinations
// open in the editor area; it never hosts chat or rich visualizations.
//
// Pattern: WebviewViewProvider (sidebar view), CSP nonce, typed bridge.

import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { handleSidebarMessage, type SidebarMessageHandlers, type SidebarDownMessage, type FileOpRequest, type FileOpResult } from "./sidebar_bridge";
import { SidebarTreeService, type RawDirEntry } from "./sidebar_tree_service";
import { detectProjectType } from "./project/detect";

/**
 * Provides the sidebar webview for the Amicode workspace panel.
 * Registered as `amicode.workspace` (type: "webview" in package.json).
 */
export class SidebarViewProvider implements vscode.WebviewViewProvider {
  private extensionUri: vscode.Uri;
  private view?: vscode.WebviewView;
  private chatActive = false;
  private activeProjectPath: string | null | undefined = undefined;
  private watcher?: vscode.FileSystemWatcher;
  private workspaceSub?: vscode.Disposable;
  private treeService: SidebarTreeService;

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
    this.treeService = new SidebarTreeService({
      detectProjectType,
      readToml: (dir) => readResearchToml(dir),
      readDirectory: (dir) => readDirectoryEntries(dir),
      getExcludePatterns: () => getExcludePatterns(),
      getWorkspaceFolders: () => (vscode.workspace.workspaceFolders ?? []) as Array<{ uri: { fsPath: string }; name: string }>,
    });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "dist"),
        vscode.Uri.joinPath(this.extensionUri, "media"),
      ],
    };

    // CSP nonce — regenerated per resolve (not cached).
    const nonce = getNonce();

    // Bundle URI for the browser entry point.
    const scriptUri = webviewView.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "sidebar_webview.js"),
    );

    webviewView.webview.html = this.buildHtml(webviewView.webview, nonce, scriptUri);

    // Wire up the bridge: webview → host messages.
    webviewView.webview.onDidReceiveMessage((msg) => {
      const handlers: SidebarMessageHandlers = {
        openChat: () => vscode.commands.executeCommand("amicode.openChat"),
        newProject: () => vscode.commands.executeCommand("amicode.newProject"),
        getRoots: () => this.treeService.getRoots(),
        getChildren: (p) => this.treeService.getChildren(p),
        openFile: (p) => {
          const uri = vscode.Uri.file(p);
          void vscode.window.showTextDocument(uri);
        },
        fileOp: (req) => executeFileOp(req),
        postMessage: (m) => {
          void webviewView.webview.postMessage(m);
        },
      };
      void handleSidebarMessage(msg, handlers);
    });

    // FileSystemWatcher — refresh subtrees on changes.
    this.setupWatcher(webviewView);

    // Refresh when workspace folders change.
    this.workspaceSub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.postDown({ kind: "roots", roots: this.treeService.getRoots() });
    });

    webviewView.onDidDispose(() => {
      this.watcher?.dispose();
      this.workspaceSub?.dispose();
      this.view = undefined;
    });
  }

  /** Push chat-active state to the webview so it can dim the button. */
  setChatActive(active: boolean): void {
    if (this.chatActive !== active) {
      this.chatActive = active;
      this.postDown({ kind: "chat-active", active });
    }
  }

  /**
   * Set the active project path (from the active session's binding).
   * Posts active-project to the webview for highlight + auto-expand.
   * Pass null to clear (no session or no project binding).
   */
  setActiveProject(projectPath: string | null): void {
    if (this.activeProjectPath === projectPath) return; // deduplicate
    this.activeProjectPath = projectPath;
    this.postDown({ kind: "active-project", path: projectPath });
  }

  private postDown(msg: SidebarDownMessage): void {
    this.view?.webview.postMessage(msg);
  }

  private setupWatcher(webviewView: vscode.WebviewView): void {
    this.watcher = vscode.workspace.createFileSystemWatcher("**/*");
    const onFsEvent = (uri: vscode.Uri) => {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (folder) {
        void webviewView.webview.postMessage({
          kind: "fs-changed",
          folder: folder.uri.fsPath,
        });
      }
    };
    this.watcher.onDidCreate(onFsEvent);
    this.watcher.onDidChange(onFsEvent);
    this.watcher.onDidDelete(onFsEvent);
  }

  private buildHtml(
    webview: vscode.Webview,
    nonce: string,
    scriptUri: string | { toString(): string },
  ): string {
    const cspSource = webview.cspSource;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${cspSource} 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-sideBarTitle-foreground, var(--vscode-foreground));
      background: var(--vscode-sideBar-background);
    }
    .sidebar-header {
      display: flex;
      gap: 6px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
    }
    .sidebar-header button {
      flex: 1;
      padding: 5px 8px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      font-family: inherit;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .btn-chat {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .btn-chat:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .btn-chat.muted {
      opacity: 0.5;
    }
    .btn-new-project {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn-new-project:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    #tree-root {
      padding: 4px 0;
    }
    .tree-node {
      display: flex;
      align-items: center;
      padding: 2px 8px 2px 0;
      cursor: pointer;
      user-select: none;
    }
    .tree-node:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .tree-node .indent {
      flex-shrink: 0;
    }
    .tree-node .icon {
      width: 16px;
      height: 16px;
      margin-right: 4px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
    }
    .tree-node .label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tree-node .pill {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 8px;
      margin-left: 6px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      flex-shrink: 0;
    }
    .tree-section-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 8px 12px 4px;
      color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-descriptionForeground));
      font-weight: 600;
    }
    .fleet-placeholder {
      padding: 8px 12px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
  </style>
</head>
<body>
  <div class="sidebar-header">
    <button class="btn-chat" id="btn-chat">Chat with Amico</button>
    <button class="btn-new-project" id="btn-new-project">+ New Project</button>
  </div>
  <div id="tree-root"></div>
  <div class="fleet-placeholder" id="fleet-section">Fleet — coming soon</div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// ── Helpers (extension host, Node runtime) ───────────────────────────────────

/** Read research-project.toml fields. Returns {} on any failure. */
function readResearchToml(dir: string): { name?: string; status?: string } {
  try {
    const tomlPath = path.join(dir, "research-project.toml");
    const content = fs.readFileSync(tomlPath, "utf8");
    // Minimal TOML key extraction (no full parser dependency — only name/status).
    const name = content.match(/^\s*name\s*=\s*"([^"]*)"/m)?.[1];
    const status = content.match(/^\s*status\s*=\s*"([^"]*)"/m)?.[1];
    return { name, status };
  } catch {
    return {};
  }
}

/** Read directory entries via Node fs. */
async function readDirectoryEntries(dir: string): Promise<RawDirEntry[]> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
    return entries.map(([name, type]) => ({
      name,
      type: type === vscode.FileType.Directory ? "directory" as const : "file" as const,
    }));
  } catch {
    return [];
  }
}

/** Get exclude patterns from files.exclude config. */
function getExcludePatterns(): string[] {
  const exclude = vscode.workspace
    .getConfiguration("files")
    .get<Record<string, boolean>>("exclude", {});
  return Object.entries(exclude)
    .filter(([, v]) => v)
    .map(([k]) => k.replace(/\*\*/g, "").replace(/\*/g, "").replace(/\//g, ""));
}

/** Cryptographically random nonce for CSP script-src. */
function getNonce(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// ── File operations (extension host, #676) ───────────────────────────────────

/**
 * Execute a file operation dispatched from the webview context menu.
 * All operations go through vscode.workspace.fs — the webview never touches
 * the filesystem directly. Delete always uses useTrash: true.
 */
async function executeFileOp(req: FileOpRequest): Promise<FileOpResult> {
  try {
    const uri = vscode.Uri.file(req.path);

    switch (req.op) {
      case "new-file": {
        if (!req.name) return { ok: false, message: "No filename provided" };
        const newUri = vscode.Uri.joinPath(uri, req.name);
        await vscode.workspace.fs.writeFile(newUri, new Uint8Array());
        void vscode.window.showTextDocument(newUri);
        return { ok: true };
      }
      case "new-folder": {
        if (!req.name) return { ok: false, message: "No folder name provided" };
        const newUri = vscode.Uri.joinPath(uri, req.name);
        await vscode.workspace.fs.createDirectory(newUri);
        return { ok: true };
      }
      case "rename": {
        if (!req.newName) return { ok: false, message: "No new name provided" };
        const dir = vscode.Uri.file(path.dirname(req.path));
        const newUri = vscode.Uri.joinPath(dir, req.newName);
        // Check for collision
        try {
          await vscode.workspace.fs.stat(newUri);
          return { ok: false, message: `"${req.newName}" already exists` };
        } catch {
          // Target doesn't exist — safe to rename
        }
        await vscode.workspace.fs.rename(uri, newUri);
        return { ok: true };
      }
      case "delete": {
        // Always trash — the permanent delete path does not exist (#673 invariant)
        await vscode.workspace.fs.delete(uri, { useTrash: true, recursive: true });
        return { ok: true };
      }
      case "copy-path": {
        await vscode.env.clipboard.writeText(uri.fsPath);
        return { ok: true };
      }
      case "copy-relative-path": {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        const rel = folder ? path.relative(folder.uri.fsPath, uri.fsPath) : uri.fsPath;
        await vscode.env.clipboard.writeText(rel);
        return { ok: true };
      }
      case "reveal-in-os": {
        await vscode.commands.executeCommand("revealFileInOS", uri);
        return { ok: true };
      }
      case "open-in-terminal": {
        const terminal = vscode.window.createTerminal({ cwd: uri.fsPath });
        terminal.show();
        return { ok: true };
      }
      case "open-to-side": {
        await vscode.commands.executeCommand("vscode.open", uri, vscode.ViewColumn.Beside);
        return { ok: true };
      }
      case "remove-from-workspace": {
        const folders = vscode.workspace.workspaceFolders ?? [];
        const idx = folders.findIndex((f) => f.uri.fsPath === req.path);
        if (idx >= 0) {
          vscode.workspace.updateWorkspaceFolders(idx, 1);
        }
        return { ok: true };
      }
      case "new-session": {
        // Posts to the session creation flow — the project path is carried
        void vscode.commands.executeCommand("amicode.newChat");
        return { ok: true };
      }
      default:
        return { ok: false, message: `Unknown operation: ${req.op}` };
    }
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
