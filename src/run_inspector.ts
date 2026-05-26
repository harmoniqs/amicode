import * as vscode from "vscode";
import * as path from "node:path";

// ============================================================================
// Run Inspector — bottom-panel webview that shows the live pulse-plot stream
// from spike_solve.jl plus a stats row driven by AMICODE_ITER parsing.
//
// Ported from amicode/src/spikes/spike_b_inspector.ts with the simulation
// experiments stripped (we don't need ping/sim now that we have a real run
// path). Keeps the throttled image swap + setImageSource / postIteration API.
// ============================================================================

const REFRESH_INTERVAL_MS = 200; // 5 Hz cap on PNG refresh

let INSPECTOR: InspectorView | undefined;

class InspectorView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  private pendingRefresh?: { fsPath: string; iter: number; isFinal: boolean };
  private refreshTimer?: NodeJS.Timeout;
  /** Set BEFORE the webview is materialized — replayed in resolveWebviewView. */
  private bufferedImage?: { fsPath: string; iter: number; isFinal: boolean };

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const resourceRoots: vscode.Uri[] = [
      vscode.Uri.joinPath(this.ctx.extensionUri, "dist"),
      vscode.Uri.joinPath(this.ctx.extensionUri, "media"),
      vscode.Uri.file("/tmp"),
    ];
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      resourceRoots.push(f.uri);
    }
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: resourceRoots,
    };
    view.webview.html = this.renderHtml(view.webview);
    view.onDidDispose(() => { this.view = undefined; this.clearTimer(); });

    // Replay the most recent pending image once the webview is alive.
    if (this.bufferedImage) {
      this.pendingRefresh = this.bufferedImage;
      this.bufferedImage = undefined;
      this.flushRefresh();
    }
  }

  // -------- public surface used by RunsRootWatcher --------

  setImageSource(fsPath: string, iter: number, isFinal: boolean = false): void {
    if (!this.view) {
      // Webview not materialized yet — keep only the most recent frame and
      // ask VS Code to open the panel. resolveWebviewView will replay it.
      this.bufferedImage = { fsPath, iter, isFinal };
      vscode.commands.executeCommand("amicode.runInspector.focus")
        .then(undefined, () => undefined);
      return;
    }
    this.pendingRefresh = { fsPath, iter, isFinal };
    if (isFinal) {
      this.clearTimer();
      this.flushRefresh();
      return;
    }
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.flushRefresh();
    }, REFRESH_INTERVAL_MS);
  }

  reveal(): void {
    // Force materialize the view via its auto-registered .focus command.
    // Unconditional — without an existing view, this is what creates one.
    vscode.commands.executeCommand("amicode.runInspector.focus")
      .then(undefined, () => undefined);
  }

  // -------- internal --------

  private clearTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  private flushRefresh(): void {
    if (!this.pendingRefresh || !this.view) return;
    const { fsPath, iter, isFinal } = this.pendingRefresh;
    this.pendingRefresh = undefined;
    const uri = vscode.Uri.file(fsPath);
    const webviewUri = this.view.webview.asWebviewUri(uri).toString();
    const url = webviewUri + (webviewUri.includes("?") ? "&" : "?") + "t=" + Date.now();
    this.view.webview.postMessage({
      type: "refresh",
      url,
      iter,
      t_post: Date.now(),
      isFinal,
    });
  }

  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.ctx.extensionUri, "dist", "inspector_webview.js"),
    );
    const nonce = newNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             img-src ${webview.cspSource} data: blob: https:;
             script-src 'nonce-${nonce}';
             style-src ${webview.cspSource} 'unsafe-inline';">
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; font-size: 12px;
           display: flex; flex-direction: column; gap: 10px; height: 100vh; box-sizing: border-box; }
    h2 { margin: 0; font-size: 13px; }
    .stat { font-family: var(--vscode-editor-font-family, monospace); }
    .header-row { display: flex; gap: 24px; align-items: center; flex-wrap: wrap; }
    .stats-row  { display: flex; gap: 24px; flex-wrap: wrap; font-size: 11px; opacity: 0.85; }
    .image-host { flex: 1 1 auto; min-height: 0; min-width: 0; position: relative;
                  background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); padding: 4px;
                  display: grid; place-items: stretch; overflow: hidden; }
    img.preview { grid-column: 1; grid-row: 1; width: 100%; height: 100%;
                  object-fit: contain; image-rendering: auto; display: block;
                  transition: opacity 50ms linear; }
    .placeholder { opacity: 0.5; font-style: italic; place-self: center; }
  </style>
</head>
<body>
  <div class="header-row">
    <h2>Run Inspector</h2>
    <div class="stat">status: <span id="status">idle</span></div>
    <div class="stat">frame: <span id="img-iter">–</span></div>
    <div class="stat">last load: <span id="img-load">–</span></div>
  </div>
  <div class="image-host">
    <img id="preview-a" class="preview" alt="frame preview A" style="opacity:0" />
    <img id="preview-b" class="preview" alt="frame preview B" style="opacity:0" />
    <div id="placeholder" class="placeholder">No solve in progress — fire one from the Amicode chat.</div>
  </div>
  <div class="stats-row">
    <span id="ping">opencode-backed</span>
    <span>iter stream: <span id="iter">0</span> recv · <span id="hz">–</span> Hz · <span id="rec">–</span> · post→recv <span id="lat">–</span></span>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function newNonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export function registerRunInspector(ctx: vscode.ExtensionContext): InspectorView {
  INSPECTOR = new InspectorView(ctx);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider("amicode.runInspector", INSPECTOR, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  return INSPECTOR;
}

export function getInspector(): InspectorView | undefined {
  return INSPECTOR;
}

// Re-export the parsing helpers so the file watcher can route directly.
export type RunOutputs = { runId: string; outputDir: string };

void path; // keep import alive if we switch to path joins in future iters
