// Catalog browser shell (#48, UX3 flat) — a seam-prototype panel, opened on
// demand via the command palette (not a persistent view). Fed entirely by
// baked fixtures in the webview entry — no RunsManager/CatalogStore. This
// module owns only the security/wiring shell: CSP, nonce, and the
// brand/layout stylesheet URIs. The shell⇄view seam is pinned by
// catalog_browser_contract.test.ts.

import * as vscode from "vscode";

let panel: vscode.WebviewPanel | undefined;

export function registerCatalogBrowser(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("amicode.openCatalogBrowser", () => {
      if (panel) {
        panel.reveal(vscode.ViewColumn.One);
        return;
      }
      panel = vscode.window.createWebviewPanel(
        "amicode.catalogBrowser",
        "Amicode: Pulse Catalog (Prototype, flat)",
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          localResourceRoots: [
            vscode.Uri.joinPath(ctx.extensionUri, "dist"),
            vscode.Uri.joinPath(ctx.extensionUri, "media"),
          ],
        },
      );
      panel.onDidDispose(() => {
        panel = undefined;
      }, null, ctx.subscriptions);
      panel.webview.html = renderHtml(ctx, panel.webview);
    }),
  );
}

function renderHtml(ctx: vscode.ExtensionContext, webview: vscode.Webview): string {
  const uri = (...parts: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, ...parts));
  const nonce = newNonce();
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}';
             style-src ${webview.cspSource} 'unsafe-inline';
             font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${uri("media", "brand.css")}" />
  <link rel="stylesheet" href="${uri("media", "layout.css")}" />
</head>
<body>
  <script nonce="${nonce}" src="${uri("dist", "catalog_browser_webview.js")}"></script>
</body>
</html>`;
}

function newNonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** Exported for tests: reset the module-level singleton between cases. */
export function _resetCatalogBrowserPanelForTests(): void {
  panel = undefined;
}
