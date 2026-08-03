import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { handleAmicodeBridgeMessage } from "./chat_bridge";
import { tabIconPath, themeKindToScheme } from "./chat_panel";
import { getBugReport } from "./bug_report";

// ============================================================================
// DeckPanel — the Chat Deck: MANY chat panes inside ONE editor tab. The heavy
// lifting lives in the shell bundle (src/deck/shell.ts → dist/deck_shell.js):
// pane groups, tab strips, drag/split/merge physics, sashes, and the per-pane
// relay. This class owns the host seam only: bootstrap config (origin, boot
// credential, scheme — minted per render, never persisted), CSP that frames
// the server origin, theme fan-out, and the shared command-bridge handler.
// Singleton per window: one deck, N panes inside it.
// ============================================================================

export class DeckPanel {
  private static current?: DeckPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel,
    opencodeUrl: URL,
    authToken?: string,
    hideProjectDir?: string,
  ) {
    this.panel.webview.html = this.renderHtml(opencodeUrl, authToken, hideProjectDir);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    // Theme fan-out: extension → shell → EVERY pane's iframe (the shell owns
    // the per-pane relay; boot scheme rides the bootstrap config).
    vscode.window.onDidChangeActiveColorTheme(
      (t) =>
        void this.panel.webview.postMessage({
          source: "amicode",
          kind: "theme",
          colorScheme: themeKindToScheme(t.kind),
        }),
      null,
      this.disposables,
    );
    this.panel.webview.onDidReceiveMessage(
      (msg) => {
        // Pane → extension bridge: the shell tags each envelope with the asking
        // pane's `tab` id; the shared handler echoes it on replies so the shell
        // routes answers to the right pane (chat_bridge.ts).
        const handled = handleAmicodeBridgeMessage(msg, {
          visible: () => this.panel.visible,
          postToWebview: (m) => void this.panel.webview.postMessage(m),
          // Bug-session lifecycle (#250) — deck panes never carry the
          // amicode_bug_report boot param, so no dock lives here; wired for
          // uniformity (the manager drops unknown ids anyway).
          bugReport: getBugReport()?.sink,
        });
        if (!handled) console.log("[amicode/deck] webview msg:", msg);
      },
      null,
      this.disposables,
    );
  }

  static openOrReveal(
    ctx: vscode.ExtensionContext,
    opencodeUrl: URL,
    authToken?: string,
    hideProjectDir?: string,
  ): DeckPanel {
    if (DeckPanel.current) {
      DeckPanel.current.panel.reveal();
      return DeckPanel.current;
    }
    const panel = vscode.window.createWebviewPanel("amicode.deck", "Amicode Chat Deck", vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      // The deck iframes the server's http origin like ChatPanel; the only
      // extension-local asset it loads is the shell bundle under dist/.
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, "dist")],
    });
    panel.iconPath = tabIconPath(ctx);
    DeckPanel.current = new DeckPanel(ctx, panel, opencodeUrl, authToken, hideProjectDir);
    return DeckPanel.current;
  }

  private renderHtml(opencodeUrl: URL, authToken?: string, hideProjectDir?: string): string {
    const nonce = randomBytes(16).toString("base64");
    const scriptUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "dist", "deck_shell.js"));
    // Bootstrap config: the credential rides ONLY here (JS memory of the
    // shell) and on frame srcs the shell mints — it is never persisted into
    // webview state. "</" is escaped so the JSON can't break out of the tag.
    const boot = {
      origin: opencodeUrl.origin,
      authToken,
      colorScheme: themeKindToScheme(vscode.window.activeColorTheme.kind),
      hideProjectDir,
    };
    const bootJson = JSON.stringify(boot).replace(/</g, "\\u003c");
    const csp = [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src ${this.panel.webview.cspSource} 'unsafe-inline'`,
      `font-src ${this.panel.webview.cspSource}`,
      `frame-src ${opencodeUrl.origin}`,
    ].join("; ");
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
</head>
<body>
  <script nonce="${nonce}">window.__AMICODE_DECK__ = ${bootJson};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {}
    }
    this.disposables.length = 0;
    if (DeckPanel.current === this) DeckPanel.current = undefined;
  }
}
