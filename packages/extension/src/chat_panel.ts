import * as vscode from "vscode";
import { randomBytes } from "node:crypto";

// ============================================================================
// ChatPanel — a single WebviewPanel that iframes opencode's SolidJS chat at
// http://127.0.0.1:<port>. Adapted directly from the opencode-v2 decompile
// (class `j` at L2499). Stays singleton: `openOrReveal` either pops the
// existing panel forward or creates a fresh one.
// ============================================================================

// Commands the in-app palette (opencode "Amico" command group) may trigger via
// the iframe→parent→extension postMessage bridge. STRICT allowlist: the framed
// app renders LLM output, so we never executeCommand anything outside this set.
const BRIDGE_ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  "amicode.restartServer",
  "amicode.distillNow",
  "amicode.stopRun",
  "amicode.savePulse",
  "amicode.openRunDir",
  "amicode.openInspector",
]);

export class ChatPanel {
  private static current?: ChatPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(private readonly panel: vscode.WebviewPanel, opencodeUrl: URL) {
    this.panel.webview.html = this.renderHtml(opencodeUrl);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg) => {
        // iframe → extension command bridge: the opencode "Amico" palette group
        // posts {source:"amicode", kind:"command", command} to window.parent;
        // the outer webview relay (renderHtml) forwards it here. We honor ONLY
        // allowlisted amicode.* commands so the framed app can't run arbitrary
        // vscode commands.
        if (
          msg &&
          typeof msg === "object" &&
          (msg as { source?: unknown }).source === "amicode" &&
          (msg as { kind?: unknown }).kind === "command" &&
          typeof (msg as { command?: unknown }).command === "string" &&
          BRIDGE_ALLOWED_COMMANDS.has((msg as { command: string }).command)
        ) {
          void vscode.commands.executeCommand((msg as { command: string }).command);
          return;
        }
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
    // the localhost frame-src. The nonce authorizes the one relay script below.
    const nonce = randomBytes(16).toString("base64");
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`,
      `frame-src ${opencodeUrl.origin}`,
      "connect-src 'self'",
    ].join("; ");
    const origin = JSON.stringify(opencodeUrl.origin);
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
  <script nonce="${nonce}">
    (function () {
      // Relay the in-app "Amico" palette's command messages from the opencode
      // iframe to the extension host. Origin-checked; the extension side keeps a
      // strict allowlist (BRIDGE_ALLOWED_COMMANDS). Iframe keystrokes never reach
      // VS Code directly, so this bridge is how the framed app triggers ops.
      var vscode = acquireVsCodeApi();
      window.addEventListener("message", function (e) {
        if (e.origin !== ${origin}) return;
        var d = e.data;
        if (d && d.source === "amicode" && d.kind === "command" && typeof d.command === "string") {
          vscode.postMessage(d);
        }
      });
    })();
  </script>
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
