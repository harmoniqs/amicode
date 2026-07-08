import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";

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
  // ⌘⇧P inside the chat iframe lands in the APP's palette, not VS Code's —
  // the fork forwards it here so the editor's Command Palette (where every
  // Amicode: command lives) opens as users expect.
  "workbench.action.showCommands",
]);

/** VS Code theme kind → the fork app's ColorScheme. */
function themeKindToScheme(kind: vscode.ColorThemeKind): "light" | "dark" {
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? "light" : "dark";
}

export class ChatPanel {
  private static current?: ChatPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    opencodeUrl: URL,
  ) {
    this.panel.webview.html = this.renderHtml(opencodeUrl);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    // Live theme bridge: editor theme changes flow extension → outer relay →
    // iframe → the app's setColorScheme (boot theme rides ?colorScheme=).
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
        // iframe → extension command bridge: the opencode "Amico" palette group
        // posts {source:"amicode", kind:"command", command} to window.parent;
        // the outer webview relay (renderHtml) forwards it here. We honor ONLY
        // allowlisted amicode.* commands so the framed app can't run arbitrary
        // vscode commands.
        if (
          msg &&
          typeof msg === "object" &&
          (msg as { source?: unknown }).source === "amicode" &&
          (msg as { kind?: unknown }).kind === "open-external" &&
          typeof (msg as { url?: unknown }).url === "string" &&
          /^https:\/\//i.test((msg as { url: string }).url) // scheme is case-insensitive (RFC 3986)
        ) {
          // target=_blank/window.open are dead inside the framed app — open
          // https links via the editor (system browser). https-only.
          void vscode.env.openExternal(vscode.Uri.parse((msg as { url: string }).url));
          return;
        }
        if (
          msg &&
          typeof msg === "object" &&
          (msg as { source?: unknown }).source === "amicode" &&
          (msg as { kind?: unknown }).kind === "clipboard-request"
        ) {
          // Paste bridge: navigator.clipboard is unavailable to the framed app
          // (the webview parent has no clipboard-read to delegate), so the app
          // asks US — the extension host reads the OS clipboard and replies.
          // Visibility gate: the app renders LLM-driven content, so a hidden
          // panel must not be able to sample the clipboard in the background —
          // reads only answer while the user can see the chat.
          if (!this.panel.visible) return;
          void vscode.env.clipboard.readText().then((text) =>
            this.panel.webview.postMessage({
              source: "amicode",
              kind: "clipboard",
              nonce: (msg as { nonce?: string }).nonce,
              text,
            }),
          );
          return;
        }
        if (
          msg &&
          typeof msg === "object" &&
          (msg as { source?: unknown }).source === "amicode" &&
          (msg as { kind?: unknown }).kind === "save-file" &&
          typeof (msg as { filename?: unknown }).filename === "string" &&
          typeof (msg as { dataUrl?: unknown }).dataUrl === "string"
        ) {
          // Save bridge (run-card PNG export): downloads are dead inside the
          // framed app — the extension shows a save dialog and writes the file.
          // PNG-only, basename-only, bounded size: the payload is untrusted.
          const raw = msg as { filename: string; dataUrl: string };
          const prefix = "data:image/png;base64,";
          const base64 = raw.dataUrl.startsWith(prefix) ? raw.dataUrl.slice(prefix.length) : undefined;
          const name = path.basename(raw.filename).replace(/[^\w.-]+/g, "-");
          if (!base64 || base64.length > 24_000_000 || !name.endsWith(".png")) return;
          void (async () => {
            const target = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.file(path.join(os.homedir(), "Downloads", name)),
              filters: { Images: ["png"] },
            });
            if (!target) return;
            await vscode.workspace.fs.writeFile(target, Buffer.from(base64, "base64"));
            const pick = await vscode.window.showInformationMessage(`Amicode: saved ${path.basename(target.fsPath)}`, "Reveal");
            if (pick === "Reveal") await vscode.commands.executeCommand("revealFileInOS", target);
          })();
          return;
        }
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
    const panel = vscode.window.createWebviewPanel("amicode.chat", "Amicode Chat", vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      // The chat lives at localhost; we let the webview reach out via http://127.0.0.1
      // through normal browser networking. No localResourceRoots needed for the iframe
      // itself — we only host one extension-local asset (the loading splash).
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, "media")],
    });
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
    // Boot theme: the app's preload reads ?colorScheme= and seeds its scheme
    // storage, so the chat opens in the EDITOR's theme (prefers-color-scheme
    // inside the webview iframe reports the OS, not VS Code).
    const framed = new URL(opencodeUrl.href);
    framed.searchParams.set("colorScheme", themeKindToScheme(vscode.window.activeColorTheme.kind));
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
  <iframe src="${framed.href}" allow="clipboard-read; clipboard-write" sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads"></iframe>
  <script nonce="${nonce}">
    (function () {
      // Relay the in-app "Amico" palette's command messages from the opencode
      // iframe to the extension host. Origin-checked; the extension side keeps a
      // strict allowlist (BRIDGE_ALLOWED_COMMANDS). Iframe keystrokes never reach
      // VS Code directly, so this bridge is how the framed app triggers ops.
      var vscode = acquireVsCodeApi();
      window.addEventListener("message", function (e) {
        var d = e.data;
        // Lane 1 — iframe → extension (commands): MUST come from the opencode
        // origin; the extension side additionally allowlists commands.
        if (e.origin === ${origin}) {
          if (d && d.source === "amicode" && (d.kind === "command" || d.kind === "clipboard-request" || d.kind === "open-external" || d.kind === "save-file")) {
            vscode.postMessage(d);
          }
          return;
        }
        // Lane 2 — extension → iframe (theme): posted by the extension host
        // (webview-internal origin, never the opencode origin). Forward only
        // our own theme envelope, pinned to the opencode origin.
        if (d && d.source === "amicode" && (d.kind === "theme" || d.kind === "clipboard")) {
          var f = document.querySelector("iframe");
          if (f && f.contentWindow) f.contentWindow.postMessage(d, ${origin});
        }
      });
    })();
  </script>
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
    if (ChatPanel.current === this) ChatPanel.current = undefined;
  }
}
