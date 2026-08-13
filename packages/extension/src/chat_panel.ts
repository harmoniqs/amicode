import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { handleAmicodeBridgeMessage } from "./chat_bridge";
import { getBugReport } from "./bug_report";

// ============================================================================
// ChatPanel — a WebviewPanel that iframes opencode's SolidJS chat at
// http://127.0.0.1:<port>. Adapted directly from the opencode-v2 decompile
// (class `j` at L2499). Multi-instance: `openOrReveal` keeps PRIMARY semantics
// (pops the front door forward or creates it), while `openNew` always spawns
// an additional tab beside the active editor — side-by-side sessions, each
// pinned to its own in-app route (e.g. /new-session), one server underneath.
// ============================================================================

/** VS Code theme kind → the fork app's ColorScheme. */
export function themeKindToScheme(kind: vscode.ColorThemeKind): "light" | "dark" {
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? "light" : "dark";
}

// Theme-adaptive tab icon for the chat WebviewPanel. The `logo` atom
// (media/ui/atoms/logo.ts) themes via fill="currentColor", but that only
// resolves inside a live webview DOM — a native tab icon is a static image
// with no DOM, so currentColor renders dark (the bug we hit). VS Code's only
// theme-adaptive path for a native icon is a literal {light, dark} URI pair,
// and — verified empirically via a probe — the files MUST live inside the
// extension folder (an icon in globalStorageUri renders as nothing). Since a
// shipped .vsix's extension folder is read-only, the two colored files can't
// be generated at runtime; they're committed under media/, derived from
// amico_reduced.svg (small context → reduced) with currentColor swapped for a
// theme-appropriate foreground gray. A unit test keeps them in sync with the
// source geometry. `light` is shown on light themes (dark mark), `dark` on
// dark themes (light mark).
export function tabIconPath(ctx: vscode.ExtensionContext): { light: vscode.Uri; dark: vscode.Uri } {
  return {
    light: vscode.Uri.joinPath(ctx.extensionUri, "media", "amico-tab-light.svg"),
    dark: vscode.Uri.joinPath(ctx.extensionUri, "media", "amico-tab-dark.svg"),
  };
}

export class ChatPanel {
  private static current?: ChatPanel;
  /** Every live chat tab (primary included) — drives tab-title numbering. */
  private static readonly live = new Set<ChatPanel>();
  /** The `amicode_bug_report=1` boot-param gate (amicode#250 AC5): set from the
   *  staged skill set after every session prep; the composer button renders
   *  only when the report-a-bug skill is there to answer it. */
  private static bugReportAvailable = false;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly tabTitle: string,
    opencodeUrl: URL,
    authToken?: string,
    hideProjectDir?: string,
  ) {
    this.panel.webview.html = this.renderHtml(opencodeUrl, authToken, hideProjectDir);
    ChatPanel.live.add(this);
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
        // iframe → extension bridge: the outer webview relay (renderHtml)
        // forwards the framed app's envelopes here; the shared handler owns the
        // strict allowlists (chat_bridge.ts, also used by the deck's panes).
        const handled = handleAmicodeBridgeMessage(msg, {
          visible: () => this.panel.visible,
          postToWebview: (m) => void this.panel.webview.postMessage(m),
          // Bug-session lifecycle (#250): the dock's bug-filed /
          // bug-report-closed route to the window's manager (undefined until
          // activation registers it; the bridge consumes the kinds regardless).
          bugReport: getBugReport()?.sink,
        });
        if (!handled) console.log("[amicode/chat] webview msg:", msg);
      },
      null,
      this.disposables,
    );
  }

  /** `authToken` is the per-boot server credential (#163) as the app's
   *  `?auth_token=` bootstrap value — base64("opencode:<password>"), from
   *  serverAuthToken(). The app adopts it for its authenticated-fetch path and
   *  strips it from the URL (entry-level history.replaceState). One value per
   *  activation, so revealing an existing panel never needs a re-render. */
  /** amicode#200 AC6: deep-link the framed app into the defaults capsule's
   *  Company Compute connect flow. Posted twice (now + 1.5s) because a freshly
   *  created panel's iframe may not be listening yet; the app side treats the
   *  request as idempotent within its freshness window. */
  postComputeConnect(): void {
    const envelope = { source: "amicode", kind: "open-compute-connect" };
    void this.panel.webview.postMessage(envelope);
    setTimeout(() => void this.panel.webview.postMessage(envelope), 1500);
  }

  /** AC5's gate setter — called after each session prep with
   *  bugReportSkillStaged(project.skillPaths). */
  static setBugReportAvailable(available: boolean): void {
    ChatPanel.bugReportAvailable = available;
  }

  /** The primary panel if one is live (never creates) — the down lane's
   *  fallback when the server is mid-restart and no ready URL exists. */
  static peek(): ChatPanel | undefined {
    return ChatPanel.current;
  }

  /** DOWN lane for the bug-report dock (amicode#250): open-bug-report /
   *  close-bug-report. Same idiom as postComputeConnect — posted twice (now +
   *  1.5s) because a freshly created panel's iframe may not be listening yet;
   *  both kinds are idempotent app-side (same-id open = reveal, close of a
   *  closed dock = no-op), so the re-post is pure reliability. Never throws:
   *  the panel can be disposed between the two posts (window closing,
   *  mid-flight reload) — a lost down-post heals via the app's boot poke. */
  postToApp(envelope: { source: "amicode"; kind: string; sessionID: string }): void {
    const post = () => {
      try {
        void this.panel.webview.postMessage(envelope);
      } catch {
        /* disposed webview — the app's poke/sync-watch covers the loss */
      }
    };
    post();
    setTimeout(post, 1500);
  }

  /** Post a draft message to the chat. The app will populate the input with this
   *  text (user can review before sending). Posted twice for reliability (same
   *  pattern as postComputeConnect). */
  postDraftMessage(message: string): void {
    const envelope = { source: "amicode", kind: "draft-message", message };
    try { void this.panel.webview.postMessage(envelope); } catch {}
    setTimeout(() => { try { void this.panel.webview.postMessage(envelope); } catch {} }, 1500);
  }

  /** The tab title of this chat panel. */
  get title(): string { return this.tabTitle; }

  /** Lowest free tab label: the lone tab reads "Amicode Chat"; extras take the
   *  smallest unused "Amicode Chat N" (N ≥ 2). Numbers free up on dispose, so a
   *  closed tab's number is reused — existing tabs are never retitled. */
  private static nextTitle(): string {
    const taken = new Set([...ChatPanel.live].map((p) => p.tabTitle));
    if (!taken.has("Amicode Chat")) return "Amicode Chat";
    for (let n = 2; ; n++) {
      const candidate = `Amicode Chat ${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  private static createPanel(
    ctx: vscode.ExtensionContext,
    column: vscode.ViewColumn,
    opencodeUrl: URL,
    authToken?: string,
    hideProjectDir?: string,
  ): ChatPanel {
    const title = ChatPanel.nextTitle();
    const panel = vscode.window.createWebviewPanel("amicode.chat", title, column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      // The chat lives at localhost; we let the webview reach out via http://127.0.0.1
      // through normal browser networking. No localResourceRoots needed for the iframe
      // itself — we only host one extension-local asset (the loading splash).
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, "media")],
    });
    panel.iconPath = tabIconPath(ctx);
    return new ChatPanel(panel, title, opencodeUrl, authToken, hideProjectDir);
  }

  static openOrReveal(
    ctx: vscode.ExtensionContext,
    opencodeUrl: URL,
    authToken?: string,
    hideProjectDir?: string,
  ): ChatPanel {
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal(vscode.ViewColumn.One);
      return ChatPanel.current;
    }
    ChatPanel.current = ChatPanel.createPanel(ctx, vscode.ViewColumn.One, opencodeUrl, authToken, hideProjectDir);
    return ChatPanel.current;
  }

  /** Side-by-side sessions: ALWAYS a fresh tab beside the active editor — the
   *  caller pins the tab's session scope via the URL (e.g. the app's
   *  /new-session draft route), so each tab owns its conversation while sharing
   *  the one opencode server underneath. */
  static openNew(
    ctx: vscode.ExtensionContext,
    opencodeUrl: URL,
    authToken?: string,
    hideProjectDir?: string,
  ): ChatPanel {
    return ChatPanel.createPanel(ctx, vscode.ViewColumn.Beside, opencodeUrl, authToken, hideProjectDir);
  }

  private renderHtml(opencodeUrl: URL, authToken?: string, hideProjectDir?: string): string {
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
    // Per-boot server credential (#163): ride the app's own ?auth_token=
    // bootstrap — its entry adopts it for every authenticated fetch and strips
    // it from the URL. The iframe src is the credential's ONLY carriage here;
    // it never appears in a log line or any other surface.
    if (authToken) framed.searchParams.set("auth_token", authToken);
    // amicode#203: the server runs in an internal scaffold dir (holds the
    // injected amico config), which opencode registers as a project. Tell the
    // app to hide exactly that dir from the dashboard so it never appears as a
    // phantom project. Only amicode sets this — standalone opencode is
    // unaffected (its cwd IS the user's project).
    if (hideProjectDir) framed.searchParams.set("amicode_hide_project", hideProjectDir);
    // amicode#250 AC5: arm the composer's report-a-bug button ONLY when the
    // staged skill set includes report-a-bug. The dock iframe (pane bug-dock)
    // never carries this — it is the main app surface's gate alone.
    if (ChatPanel.bugReportAvailable) framed.searchParams.set("amicode_bug_report", "1");
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
          // Image paste: the outer webview CAN read clipboard images
          // (navigator.clipboard.read is granted here); the sandboxed iframe
          // can't, and vscode.env.clipboard is text-only. So we answer this one
          // client-side instead of forwarding it to the host.
          if (d && d.source === "amicode" && d.kind === "clipboard-image-request") {
            replyClipboardImage(d.nonce);
            return;
          }
          if (d && d.source === "amicode" && (d.kind === "command" || d.kind === "clipboard-request" || d.kind === "clipboard-write" || d.kind === "open-external" || d.kind === "open-file" || d.kind === "save-file" || d.kind === "set-default-model" || d.kind === "bug-filed" || d.kind === "bug-report-closed" || d.kind === "bug-report-poke")) {
            vscode.postMessage(d);
          }
          return;
        }
        // Lane 2 — extension → iframe: posted by the extension host
        // (webview-internal origin, never the opencode origin). Forward only
        // our own envelopes, pinned to the opencode origin.
        if (d && d.source === "amicode" && (d.kind === "theme" || d.kind === "clipboard" || d.kind === "open-compute-connect" || d.kind === "open-bug-report" || d.kind === "close-bug-report" || d.kind === "draft-message")) {
          var f = document.querySelector("iframe");
          if (f && f.contentWindow) f.contentWindow.postMessage(d, ${origin});
        }
      });

      // Answer a clipboard-image-request from the framed app: read the first
      // image/* item off the OS clipboard (client-side; clipboard-read is
      // granted to this webview) and post it into the frame as a data URL. On
      // any failure we still reply with dataUrl:null so the app falls back to
      // text paste rather than hanging on its timeout.
      function blobToDataUrl(blob) {
        return new Promise(function (res) {
          var r = new FileReader();
          r.onload = function () { res(typeof r.result === "string" ? r.result : null); };
          r.onerror = function () { res(null); };
          r.readAsDataURL(blob);
        });
      }
      async function replyClipboardImage(nonce) {
        var payload = { source: "amicode", kind: "clipboard-image", nonce: nonce, dataUrl: null, mime: null, filename: null };
        try {
          if (navigator.clipboard && navigator.clipboard.read) {
            var items = await navigator.clipboard.read();
            for (var i = 0; i < items.length && !payload.dataUrl; i++) {
              var types = items[i].types || [];
              for (var j = 0; j < types.length; j++) {
                if (types[j].indexOf("image/") !== 0) continue;
                var blob = await items[i].getType(types[j]);
                var dataUrl = await blobToDataUrl(blob);
                if (dataUrl) {
                  payload.dataUrl = dataUrl;
                  payload.mime = types[j];
                  payload.filename = "pasted-image." + (types[j].split("/")[1] || "png");
                }
                break;
              }
            }
          }
        } catch (e) { /* reply with dataUrl:null → app falls back to text paste */ }
        var f = document.querySelector("iframe");
        if (f && f.contentWindow) f.contentWindow.postMessage(payload, ${origin});
      }
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
    ChatPanel.live.delete(this);
    if (ChatPanel.current === this) ChatPanel.current = undefined;
  }
}
