// sidebar_view.ts — WebviewViewProvider for the Amicode sidebar (#673, slice 1).
//
// Replaces the native TreeDataProvider (workspace_tree.ts) with a webview that
// can render custom UI: styled buttons, project metadata, lifecycle pills, and
// eventually a fleet section. The sidebar is navigation chrome — destinations
// open in the editor area; it never hosts chat or rich visualizations.
//
// Pattern: WebviewViewProvider (sidebar view), CSP nonce, typed bridge.

import * as vscode from "vscode";
import { handleSidebarMessage, type SidebarMessageHandlers } from "./sidebar_bridge";

/**
 * Provides the sidebar webview for the Amicode workspace panel.
 * Registered as `amicode.workspace` (type: "webview" in package.json).
 */
export class SidebarViewProvider implements vscode.WebviewViewProvider {
  private extensionUri: vscode.Uri;
  private view?: vscode.WebviewView;
  private chatActive = false;

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
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
      };
      handleSidebarMessage(msg, handlers);
    });
  }

  /** Push chat-active state to the webview so it can dim the button. */
  setChatActive(active: boolean): void {
    if (this.chatActive !== active) {
      this.chatActive = active;
      this.view?.webview.postMessage({ kind: "chat-active", active });
    }
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
  </style>
</head>
<body>
  <div class="sidebar-header">
    <button class="btn-chat" id="btn-chat">Chat with Amico</button>
    <button class="btn-new-project" id="btn-new-project">+ New Project</button>
  </div>
  <div id="tree-root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
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
