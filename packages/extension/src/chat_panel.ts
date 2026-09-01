import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { handleAmicodeBridgeMessage } from "./chat_bridge";
import { registerInspectorPoster } from "./inspector_bridge";
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
  /** Callback fired whenever the number of live chat panels changes. */
  private static onLiveChangeCallback?: (count: number) => void;
  /** The `amicode_bug_report=1` boot-param gate (amicode#250 AC5): set from the
   *  staged skill set after every session prep; the composer button renders
   *  only when the report-a-bug skill is there to answer it. */
  private static bugReportAvailable = false;
  /** One-shot flag: when true, the next openOrReveal posts a navigate message
   *  to start a new session with the onboarding greeting auto-sent. Cleared
   *  after use. Set by the onboarding panel after config-success/confirm-import. */
  private static pendingOnboardingGreeting = false;
  /** Callbacks fired when the app signals ready (app-ready message from iframe). */
  private static appReadyCallbacks: Array<() => void> = [];
  private readonly disposables: vscode.Disposable[] = [];

  /** Subscribe to live-panel count changes. Used by the workspace tree to mute the chat button. */
  static onLiveChange(cb: (count: number) => void): void {
    ChatPanel.onLiveChangeCallback = cb;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly tabTitle: string,
    opencodeUrl: URL,
    authToken?: string,
    hideProjectDir?: string,
    withSplash?: boolean,
  ) {
    this.panel.webview.html = withSplash
      ? this.renderTransitionHtml(opencodeUrl, authToken, hideProjectDir)
      : this.renderHtml(opencodeUrl, authToken, hideProjectDir);
    ChatPanel.live.add(this);
    ChatPanel.onLiveChangeCallback?.(ChatPanel.live.size);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    // #351: register this panel as an inspector poster — RunsManager / device
    // poll fan out run/device envelopes to every live chat webview.
    this.disposables.push(registerInspectorPoster((msg) => void this.panel.webview.postMessage(msg)));
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
    // Derive the extension's server auth header from the same per-boot token
    // the iframe bootstraps with — so Connections proxy POSTs carry the
    // identical #163 credential even while the chat SSE is streaming.
    const serverAuth = authToken ? `Basic ${authToken}` : undefined;
    const serverUrl = opencodeUrl.origin;
    this.panel.webview.onDidReceiveMessage(
      (msg) => {
        // app-ready: the SolidJS app has mounted and is rendering. Fire
        // any registered callbacks (one-shot) and clear the list.
        if (msg && msg.source === "amicode" && msg.kind === "app-ready") {
          const cbs = ChatPanel.appReadyCallbacks.slice();
          ChatPanel.appReadyCallbacks = [];
          for (const cb of cbs) cb();
          return;
        }
        // iframe → extension bridge: the outer webview relay (renderHtml)
        // forwards the framed app's envelopes here; the shared handler owns the
        // strict allowlists (chat_bridge.ts, also used by the deck's panes).
        const handled = handleAmicodeBridgeMessage(msg, {
          visible: () => this.panel.visible,
          postToWebview: (m) => void this.panel.webview.postMessage(m),
          ...(serverAuth ? { server: { url: serverUrl, authorization: serverAuth } } : {}),
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

  /** Post a navigate message to open a new session with the onboarding
   *  prompt auto-sent. Waits for the app-ready signal before posting (the app
   *  must be mounted to handle the navigate). Falls back to a timeout if
   *  app-ready never fires. */
  postOnboardingGreeting(timeoutMs = 10_000): void {
    const prompt = encodeURIComponent("Let's begin onboarding.");
    const path = `/new-session?prompt=${prompt}&autoSend=1`;
    const envelope = { source: "amicode", kind: "navigate", path };
    let sent = false;
    const send = () => {
      if (sent) return;
      sent = true;
      void this.panel.webview.postMessage(envelope);
    };
    ChatPanel.onAppReady(send);
    // Fallback: if app-ready never fires (server hung, iframe broken),
    // post after timeout so the user isn't stuck on the splash forever.
    setTimeout(send, timeoutMs);
  }

  /** Post an arbitrary message to the webview (relayed to the iframe). */
  postMessage(msg: unknown): Thenable<boolean> {
    return this.panel.webview.postMessage(msg);
  }

  /** AC5's gate setter — called after each session prep with
   *  bugReportSkillStaged(project.skillPaths). */
  static setBugReportAvailable(available: boolean): void {
    ChatPanel.bugReportAvailable = available;
  }

  /** Set by the onboarding panel after config is written — the next
   *  openOrReveal will post a navigate message to auto-send the greeting. */
  static setPendingOnboardingGreeting(pending: boolean): void {
    ChatPanel.pendingOnboardingGreeting = pending;
  }

  /** Clear the pending greeting flag (test cleanup / manual reset). */
  static clearPendingOnboardingGreeting(): void {
    ChatPanel.pendingOnboardingGreeting = false;
  }

  /** Register a one-shot callback for when the app signals ready.
   *  All registered callbacks fire once on the first app-ready message,
   *  then the list is cleared. */
  static onAppReady(cb: () => void): void {
    ChatPanel.appReadyCallbacks.push(cb);
  }

  /** Clear app-ready callbacks (test cleanup). */
  static clearAppReadyCallbacks(): void {
    ChatPanel.appReadyCallbacks = [];
  }

  /** Consume and clear the pending greeting flag. Returns true if it was set. */
  static consumePendingOnboardingGreeting(): boolean {
    if (!ChatPanel.pendingOnboardingGreeting) return false;
    ChatPanel.pendingOnboardingGreeting = false;
    return true;
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

  /** Adopt an existing WebviewPanel (e.g. the onboarding panel) as the chat
   *  singleton. Swaps its HTML to the chat iframe with a splash overlay on top,
   *  wires message relay + bridge, and registers it as the primary ChatPanel.
   *  No new panel is created — zero tab switching. */
  /** The brand face, as a webview URI. The transition overlay must render
   *  IDENTICALLY to the onboarding splash it replaces — same mark colour, same
   *  typeface — or adopt() shows a visible flash mid-animation. */
  private static fontUri?: string;

  static adopt(
    panel: vscode.WebviewPanel,
    ctx: vscode.ExtensionContext,
    opencodeUrl: URL,
    authToken?: string,
    hideProjectDir?: string,
  ): ChatPanel {
    ChatPanel.fontUri = panel.webview
      .asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "media", "ui", "atoms", "DMSans-Variable.woff2"))
      .toString();
    // If there's already a ChatPanel singleton, dispose it (shouldn't happen in normal flow)
    if (ChatPanel.current) {
      ChatPanel.current.dispose();
    }
    const title = "Amicode Chat";
    const instance = new ChatPanel(panel, title, opencodeUrl, authToken, hideProjectDir, true);
    ChatPanel.current = instance;
    panel.title = title;
    panel.iconPath = tabIconPath(ctx);
    return instance;
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
    // Developer mode: when devAssetRoot is configured, signal the app to
    // enable its developer badge/settings. Without this, the setting is lost
    // on every reload because ephemeral ports rotate the localStorage origin.
    const devAssetRoot = (vscode.workspace.getConfiguration("amicode").get<string>("devAssetRoot", "") ?? "").trim();
    if (devAssetRoot) framed.searchParams.set("amicode_developer", "1");
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
          // Image paste: forward to the extension host which reads the clipboard
          // image natively (osascript/xclip/powershell). The browser Clipboard API
          // in the outer webview requires user activation from a keystroke on THIS
          // document, but the keystroke fires inside the iframe — so the async API
          // throws. The extension host has no such constraint.
          if (d && d.source === "amicode" && d.kind === "clipboard-image-request") {
            vscode.postMessage({ source: "amicode", kind: "clipboard-image-read", nonce: d.nonce });
            return;
          }
          if (d && d.source === "amicode" && (d.kind === "command" || d.kind === "clipboard-request" || d.kind === "clipboard-write" || d.kind === "open-external" || d.kind === "open-file" || d.kind === "save-file" || d.kind === "set-default-model" || d.kind === "bug-filed" || d.kind === "bug-report-closed" || d.kind === "bug-report-poke" || d.kind === "dev-tools-update" || d.kind === "dev-tools-rebuild" || d.kind === "dev-tools-build-vsix" || d.kind === "data-storage-query" || d.kind === "data-storage-update" || d.kind === "redo-onboarding" || d.kind === "device:refresh" || d.kind === "connections-credential" || d.kind === "connections-disconnect" || d.kind === "connections-revalidate" || d.kind === "connections-auth" || d.kind === "connections-choose-project" || d.kind === "connections-add-custom" || d.kind === "connections-remove" || d.kind === "skill-providers-query" || d.kind === "skill-providers-add" || d.kind === "skill-providers-remove" || d.kind === "skill-providers-rename" || d.kind === "skill-providers-autodiscover" || d.kind === "skill-providers-pick-directory" || d.kind === "add-workspace-project" || d.kind === "app-ready")) {
            vscode.postMessage(d);
          }
          return;
        }
        // Lane 2 — extension → iframe: posted by the extension host
        // (webview-internal origin, never the opencode origin). Forward only
        // our own envelopes, pinned to the opencode origin. #351 adds
        // run:*/device:* envelopes for the Work Column inspector tabs.
        if (d && d.source === "amicode" && (d.kind === "theme" || d.kind === "clipboard" || d.kind === "navigate" || d.kind === "open-compute-connect" || d.kind === "open-bug-report" || d.kind === "close-bug-report" || d.kind === "dev-tools-status" || d.kind === "dev-tools-rebuild-status" || d.kind === "dev-tools-build-vsix-status" || d.kind === "data-storage-defaults" || d.kind === "data-storage-status" || d.kind === "connections-credential-result" || d.kind === "connections-disconnect-result" || d.kind === "connections-revalidate-result" || d.kind === "connections-auth-result" || d.kind === "connections-choose-project-result" || d.kind === "connections-add-custom-result" || d.kind === "connections-remove-result" || d.kind === "skill-providers-data" || d.kind === "skill-providers-discovered" || (typeof d.kind === "string" && (d.kind.indexOf("run:") === 0 || d.kind.indexOf("device:") === 0)) || d.kind === "clipboard-image" || d.kind === "workspace-projects")) {
          var f = document.querySelector("iframe");
          if (f && f.contentWindow) f.contentWindow.postMessage(d, ${origin});
        }
      });
    })();
  </script>
</body>
</html>`;
  }

  /** Render the chat iframe HTML with a splash overlay on top.
   *  Used by adopt() — the overlay fades out when app-ready fires, revealing
   *  the fully-loaded chat underneath. Zero tab switching, pure CSS transition. */
  private renderTransitionHtml(opencodeUrl: URL, authToken?: string, hideProjectDir?: string): string {
    const nonce = randomBytes(16).toString("base64");
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`,
      `frame-src ${opencodeUrl.origin}`,
      "connect-src 'self'",
      // the overlay's face has to load, or it renders in a different typeface
      // from the splash it is replacing
      `font-src ${this.panel.webview.cspSource}`,
    ].join("; ");
    const fontFace = ChatPanel.fontUri
      ? `@font-face { font-family: "DM Sans"; src: url("${ChatPanel.fontUri}") format("woff2-variations"); font-weight: 100 1000; font-display: swap; }`
      : "";
    const origin = JSON.stringify(opencodeUrl.origin);
    const framed = new URL(opencodeUrl.href);
    framed.searchParams.set("colorScheme", themeKindToScheme(vscode.window.activeColorTheme.kind));
    if (authToken) framed.searchParams.set("auth_token", authToken);
    if (hideProjectDir) framed.searchParams.set("amicode_hide_project", hideProjectDir);
    if (ChatPanel.bugReportAvailable) framed.searchParams.set("amicode_bug_report", "1");
    const devAssetRootTransition = (vscode.workspace.getConfiguration("amicode").get<string>("devAssetRoot", "") ?? "").trim();
    if (devAssetRootTransition) framed.searchParams.set("amicode_developer", "1");
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style>
    ${fontFace}
    html, body, iframe { margin: 0; padding: 0; height: 100%; width: 100%; border: 0; }
    body { background: var(--vscode-editor-background); overflow: hidden; }
    iframe { display: block; position: absolute; top: 0; left: 0; z-index: 1; }
    .splash-overlay {
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      z-index: 10; display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      background: var(--vscode-editor-background);
      transition: opacity 0.4s ease-out, transform 0.4s ease-out;
    }
    .splash-overlay.fade-out {
      opacity: 0; transform: scale(1.05); pointer-events: none;
    }
    /* These three MUST stay byte-identical to splashHtml() in
       onboarding_panel.ts — adopt() swaps one for the other mid-animation, so
       any divergence in colour or face shows up as a flash. */
    .splash-text {
      margin-top: 16px; font-size: 1.4rem;
      color: var(--vscode-foreground, #ccc);
      font-family: "DM Sans", var(--vscode-font-family, system-ui);
    }
    .splash-mark {
      width: 176px; height: 157px;
      fill: var(--color-accent-ink, #FFE614);
      overflow: visible;
    }
    body.vscode-light .splash-mark,
    body.vscode-high-contrast-light .splash-mark {
      fill: #000000;
    }
    .splash-mark .mark-breathe {
      transform-box: fill-box; transform-origin: 50% 100%;
      animation: jump 2.0s ease-in-out infinite;
    }
    @keyframes jump {
      0%, 40% { transform: translateY(0) scale(1, 1); }
      46% { transform: translateY(0) scale(1.08, 0.92); }
      58% { transform: translateY(-60px) scale(0.96, 1.05); }
      70% { transform: translateY(0) scale(1.06, 0.94); }
      80% { transform: translateY(-20px) scale(0.99, 1.02); }
      88%, 100% { transform: translateY(0) scale(1, 1); }
    }
  </style>
</head>
<body>
  <div class="splash-overlay" id="splash">
    <svg class="splash-mark" viewBox="2 74 3596 3212" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Amico">
      <g class="mark-breathe">
        <!-- Outer bracket frame -->
        <path fill-rule="evenodd" d="M2279.19,374.09v622.56h-958.38V374.09H202.07v2851.83h1118.74v-520.15h958.38v520.15h1118.74V374.09h-1118.74ZM3165.55,2523.71H478.91v-1338.38h2686.65v1338.38Z"/>
        <!-- Left caret < -->
        <polygon points="888.52 1864.8 754.93 1864.8 754.93 1727.36 888.55 1727.36 888.55 1864.77 1022.15 1864.77 1022.15 2002.21 888.52 2002.21 888.52 1864.8"/>
        <polygon points="621.31 1589.92 754.9 1589.92 754.9 1452.48 888.52 1452.48 888.52 1589.92 754.93 1589.92 754.93 1727.36 621.31 1727.36 621.31 1589.92"/>
        <polygon points="754.92 1452.48 888.51 1452.48 888.51 1315.04 1022.13 1315.04 1022.13 1452.48 888.54 1452.48 888.54 1589.92 754.92 1589.92 754.92 1452.48"/>
        <!-- Left happy eye (∩ = top bar + two side bars, centered in bracket) -->
        <rect x="1139.77" y="1647" width="133.62" height="286"/>
        <rect x="1503.05" y="1647" width="133.62" height="286"/>
        <rect x="1273.58" y="1510" width="229.47" height="137.44"/>
        <!-- Centre divider | -->
        <rect x="1778.31" y="1450" width="107.11" height="692.38"/>
        <!-- Right happy eye (∩ = top bar + two side bars, centered in bracket) -->
        <rect x="2009.75" y="1647" width="133.62" height="286"/>
        <rect x="2373.03" y="1647" width="133.62" height="286"/>
        <rect x="2143.56" y="1510" width="229.47" height="137.44"/>
        <!-- Smile (same as opening screen) -->
        <rect x="1648.65" y="2256.8" width="349.19" height="137.44"/>
        <rect x="1510.91" y="2119.73" width="138.82" height="138.82"/>
        <rect x="1997.85" y="2117.98" width="138.82" height="138.82"/>
        <!-- Right caret > -->
        <polygon points="2769.41 1463.57 2903.01 1463.57 2903.01 1601.01 2769.39 1601.01 2769.39 1463.6 2635.79 1463.6 2635.79 1326.16 2769.41 1326.16 2769.41 1463.57"/>
        <polygon points="3036.63 1738.45 2903.03 1738.45 2903.03 1875.89 2769.41 1875.89 2769.41 1738.45 2903.01 1738.45 2903.01 1601.01 3036.63 1601.01 3036.63 1738.45"/>
        <polygon points="2903.02 1875.89 2769.43 1875.89 2769.43 2013.33 2635.81 2013.33 2635.81 1875.89 2769.4 1875.89 2769.4 1738.45 2903.02 1738.45 2903.02 1875.89"/>
      </g>
    </svg>
    <div class="splash-text">Getting Amico ready...</div>
  </div>
  <iframe src="${framed.href}" allow="clipboard-read; clipboard-write" sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads"></iframe>
  <script nonce="${nonce}">
    (function () {
      var vscode = acquireVsCodeApi();
      var origin = ${origin};
      var splashStart = Date.now();
      var MIN_SPLASH_MS = 5000; // minimum 5s display time

      function fadeSplash() {
        var splash = document.getElementById("splash");
        if (splash) {
          splash.classList.add("fade-out");
          splash.addEventListener("transitionend", function () { splash.remove(); });
        }
      }

      window.addEventListener("message", function (e) {
        var d = e.data;
        if (e.origin === origin) {
          // app-ready: fade the splash overlay after minimum display time
          if (d && d.source === "amicode" && d.kind === "app-ready") {
            var elapsed = Date.now() - splashStart;
            var remaining = Math.max(0, MIN_SPLASH_MS - elapsed);
            setTimeout(fadeSplash, remaining);
            // Relay to extension immediately (so navigate posts on time)
            vscode.postMessage(d);
            return;
          }
          if (d && d.source === "amicode" && d.kind === "clipboard-image-request") {
            vscode.postMessage({ source: "amicode", kind: "clipboard-image-read", nonce: d.nonce });
            return;
          }
          if (d && d.source === "amicode" && (d.kind === "command" || d.kind === "clipboard-request" || d.kind === "clipboard-write" || d.kind === "open-external" || d.kind === "open-file" || d.kind === "save-file" || d.kind === "set-default-model" || d.kind === "bug-filed" || d.kind === "bug-report-closed" || d.kind === "bug-report-poke" || d.kind === "dev-tools-update" || d.kind === "dev-tools-rebuild" || d.kind === "dev-tools-build-vsix" || d.kind === "data-storage-query" || d.kind === "data-storage-update" || d.kind === "redo-onboarding" || d.kind === "device:refresh" || d.kind === "connections-credential" || d.kind === "connections-disconnect" || d.kind === "connections-revalidate" || d.kind === "connections-auth" || d.kind === "connections-choose-project" || d.kind === "connections-add-custom" || d.kind === "connections-remove" || d.kind === "skill-providers-query" || d.kind === "skill-providers-add" || d.kind === "skill-providers-remove" || d.kind === "skill-providers-rename" || d.kind === "skill-providers-autodiscover" || d.kind === "skill-providers-pick-directory" || d.kind === "add-workspace-project" || d.kind === "app-ready")) {
            vscode.postMessage(d);
          }
          return;
        }
        if (d && d.source === "amicode" && (d.kind === "theme" || d.kind === "clipboard" || d.kind === "navigate" || d.kind === "open-compute-connect" || d.kind === "open-bug-report" || d.kind === "close-bug-report" || d.kind === "dev-tools-status" || d.kind === "dev-tools-rebuild-status" || d.kind === "dev-tools-build-vsix-status" || d.kind === "data-storage-defaults" || d.kind === "data-storage-status" || d.kind === "connections-credential-result" || d.kind === "connections-disconnect-result" || d.kind === "connections-revalidate-result" || d.kind === "connections-auth-result" || d.kind === "connections-choose-project-result" || d.kind === "connections-add-custom-result" || d.kind === "connections-remove-result" || d.kind === "skill-providers-data" || d.kind === "skill-providers-discovered" || (typeof d.kind === "string" && (d.kind.indexOf("run:") === 0 || d.kind.indexOf("device:") === 0)) || d.kind === "clipboard-image" || d.kind === "workspace-projects")) {
          var f = document.querySelector("iframe");
          if (f && f.contentWindow) f.contentWindow.postMessage(d, origin);
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
    ChatPanel.live.delete(this);
    ChatPanel.onLiveChangeCallback?.(ChatPanel.live.size);
    if (ChatPanel.current === this) ChatPanel.current = undefined;
  }

  /** Close the current singleton chat panel (if one exists). Used by redo-onboarding
   *  to clear the view before opening the onboarding webview. */
  static disposeCurrent(): void {
    if (ChatPanel.current) {
      ChatPanel.current.panel.dispose();
    }
  }
}
