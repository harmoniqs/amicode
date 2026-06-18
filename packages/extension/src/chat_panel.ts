import * as vscode from "vscode";

// ============================================================================
// ChatPanel — a single WebviewPanel that iframes opencode's SolidJS chat at
// http://127.0.0.1:<port>. Adapted directly from the opencode-v2 decompile
// (class `j` at L2499). Stays singleton: `openOrReveal` either pops the
// existing panel forward or creates a fresh one.
// ============================================================================

export class ChatPanel {
  private static current?: ChatPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(private readonly panel: vscode.WebviewPanel, opencodeUrl: URL) {
    this.panel.webview.html = this.renderHtml(opencodeUrl);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg) => {
        // Reserved for future iframe → extension postMessage protocol.
        // For now we don't depend on it — control flow goes through the
        // local HTTP callback (Channel 2) instead.
        console.log("[amicode/chat] webview msg:", msg);
      },
      null,
      this.disposables,
    );
  }

  static openOrReveal(ctx: vscode.ExtensionContext, opencodeUrl: URL): ChatPanel {
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal(vscode.ViewColumn.One);
      return ChatPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      "amicode.chat",
      "Amicode Chat",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        // The chat lives at localhost; we let the webview reach out via http://127.0.0.1
        // through normal browser networking. No localResourceRoots needed for the iframe
        // itself — we only host one extension-local asset (the loading splash).
        localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, "media")],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, "media", "amico.svg");
    ChatPanel.current = new ChatPanel(panel, opencodeUrl);
    return ChatPanel.current;
  }

  private renderHtml(opencodeUrl: URL): string {
    // CSP: allow the iframe to load opencode's localhost origin. The frame
    // itself is isolated, but VS Code's webview CSP needs to explicitly grant
    // the localhost frame-src.
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `frame-src ${opencodeUrl.origin}`,
      "connect-src 'self'",
    ].join("; ");
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style>
    html, body, iframe { margin: 0; padding: 0; height: 100%; width: 100%; border: 0; }
    body { background: var(--vscode-editor-background); }
    iframe { display: block; }
  </style>
</head>
<body>
  <iframe src="${opencodeUrl.href}" allow="clipboard-read; clipboard-write" sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads"></iframe>
</body>
</html>`;
  }

  dispose(): void {
    for (const d of this.disposables) {
      try { d.dispose(); } catch {}
    }
    this.disposables.length = 0;
    if (ChatPanel.current === this) ChatPanel.current = undefined;
  }
}
