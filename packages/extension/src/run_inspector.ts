import * as vscode from "vscode";
import * as path from "node:path";
import { inspectorResourceRootDirs } from "./opencode_paths";

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
  /** Terminal state that arrived before the webview existed (e.g. on launch the
   *  watcher follows `latest` → a finished run completes before the panel is
   *  opened). Replayed after the buffered image so the badge isn't stuck "running". */
  private bufferedCompletion?: { status: string; fidelity?: number };
  /** A run started but hasn't emitted its first frame yet (Julia warming up).
   *  Buffered so the warming state shows even if the panel opens late. */
  private bufferedWarming = false;
  /** Run label (runId) for the topbar — buffered so it shows even if the panel
   *  opens after the run was selected. */
  private bufferedRunLabel?: string;

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly runsRoot: string) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    // Q69: include the runs-root, else iter_*.png under ~/.amico/runs/... is
    // CSP-blocked → permanently blank inspector.
    const resourceRoots: vscode.Uri[] = inspectorResourceRootDirs(this.ctx.extensionUri.fsPath, this.runsRoot)
      .map((d) => vscode.Uri.file(d));
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      resourceRoots.push(f.uri);
    }
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: resourceRoots,
    };
    view.webview.html = this.renderHtml(view.webview);
    view.onDidDispose(() => { this.view = undefined; this.clearTimer(); });

    // Topbar run label — replay first so it's set regardless of run state.
    if (this.bufferedRunLabel) {
      view.webview.postMessage({ type: "runlabel", text: this.bufferedRunLabel });
      this.bufferedRunLabel = undefined;
    }
    // A run is warming up (no frame yet) — show that until the first frame.
    if (this.bufferedWarming && !this.bufferedImage) {
      this.bufferedWarming = false;
      view.webview.postMessage({ type: "warming" });
    }
    // Replay the most recent pending image once the webview is alive.
    if (this.bufferedImage) {
      this.pendingRefresh = this.bufferedImage;
      this.bufferedImage = undefined;
      this.flushRefresh();
    }
    // Then replay a terminal state if the run already finished — after the
    // image so "converged"/"failed" wins over the replayed frame's "running".
    if (this.bufferedCompletion) {
      const c = this.bufferedCompletion;
      this.bufferedCompletion = undefined;
      view.webview.postMessage({ type: "completed", status: c.status, fidelity: c.fidelity });
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

  postIterationRecord(rec: { iter: number; f_val: number; inf_pr: number; inf_du: number }): void {
    if (!this.view) return; // ok to drop iter records if not visible — image stream is the canonical signal
    this.view.webview.postMessage({
      type: "iteration",
      iter:      rec.iter,
      f_val:     rec.f_val,
      kkt_error: rec.inf_du,
      eq_viol:   rec.inf_pr,
      ineq_viol: 0,
      rho:       1.0,
      t_post:    Date.now(),
    });
  }

  /** Terminal-state signal so the badge stops saying "running". The watcher
   *  streams frames without an isFinal marker (it can't know which frame is
   *  last mid-solve), so completion is delivered separately — on live finish
   *  AND when switching to an already-finished run. Flush any pending frame
   *  first so this is the last word the webview hears for the run. */
  postCompletion(status: string, fidelity?: number): void {
    if (!this.view) {
      // Panel not open yet — stash; resolveWebviewView replays it after the image.
      this.bufferedCompletion = { status, fidelity };
      return;
    }
    this.clearTimer();
    this.flushRefresh();
    this.view.webview.postMessage({ type: "completed", status, fidelity });
  }

  /** A run started but has no frame yet (Julia/Makie warming up) — show that
   *  instead of an idle panel, so a ~minute of cold start doesn't read as frozen.
   *  Replaced by the first frame (the refresh handler hides the placeholder). */
  setWarmingUp(): void {
    if (!this.view) {
      this.bufferedWarming = true;
      vscode.commands.executeCommand("amicode.runInspector.focus").then(undefined, () => undefined);
      return;
    }
    this.view.webview.postMessage({ type: "warming" });
  }

  /** Set the topbar run label (runId). Buffered until the webview materializes. */
  setRunLabel(label: string): void {
    if (!this.view) { this.bufferedRunLabel = label; return; }
    this.view.webview.postMessage({ type: "runlabel", text: label });
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
    :root {
      --amico-accent: #FFF676;            /* amico yellow */
      --amico-run: #FFF676;               /* running — brand yellow */
      --amico-ok: #3fb950;                /* converged green */
      --amico-fail: #f85149;              /* failed red */
    }
    * { box-sizing: border-box; }
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
           padding: 14px; font-size: 12px; display: flex; flex-direction: column; gap: 12px;
           height: 100vh; overflow-y: auto; }
    /* ---- top bar ---- */
    .topbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .brand { display: flex; align-items: center; gap: 9px; font-size: 13px; font-weight: 600; }
    .mark { font-family: var(--vscode-editor-font-family, monospace); color: var(--amico-accent);
            letter-spacing: 1px; font-weight: 700;
            border: 1px solid color-mix(in srgb, var(--amico-accent) 55%, transparent);
            border-radius: 6px; padding: 1px 7px; font-size: 12px; }
    .runlabel { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; opacity: 0.6; }
    .badge { margin-left: auto; font-size: 10.5px; font-weight: 600; letter-spacing: 0.5px;
             text-transform: uppercase; padding: 3px 10px; border-radius: 999px;
             border: 1px solid currentColor; display: inline-flex; align-items: center; gap: 6px; }
    .badge::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    .badge.idle    { color: var(--vscode-descriptionForeground); opacity: 0.7; }
    .badge.running { color: var(--amico-run); }
    .badge.running::before { animation: pulse 1.1s ease-in-out infinite; }
    .badge.done    { color: var(--amico-ok); }
    .badge.failed  { color: var(--amico-fail); }
    @keyframes pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.35; transform: scale(0.7); } }
    /* ---- plot hero ---- */
    /* min-height keeps the pulse plot a real plot, not a thin bar, when the
       bottom panel is short; body scrolls if the panel can't fit it all. */
    .image-host { flex: 1 1 240px; min-height: 240px; min-width: 0; position: relative;
                  background: var(--vscode-editor-background);
                  border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 6px;
                  display: grid; place-items: stretch; overflow: hidden; }
    img.preview { grid-column: 1; grid-row: 1; width: 100%; height: 100%;
                  object-fit: contain; display: block; transition: opacity 120ms ease; }
    .placeholder { place-self: center; text-align: center; opacity: 0.55; display: flex;
                   flex-direction: column; align-items: center; gap: 10px; }
    .placeholder .mark { font-size: 20px; padding: 4px 12px; opacity: 0.8; }
    .placeholder .hint { font-style: italic; max-width: 240px; line-height: 1.5; }
    /* ---- metric cards ---- */
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(112px, 1fr)); gap: 8px; }
    .card { background: color-mix(in srgb, var(--vscode-panel-border) 25%, transparent);
            border: 1px solid var(--vscode-panel-border); border-radius: 7px; padding: 8px 10px;
            display: flex; flex-direction: column; gap: 3px; }
    .card .k { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.6px;
               opacity: 0.55; font-weight: 600; }
    .card .v { font-family: var(--vscode-editor-font-family, monospace); font-size: 14px; }
    .card.hero { border-color: color-mix(in srgb, var(--amico-accent) 45%, var(--vscode-panel-border)); }
    .card.hero .k { color: var(--amico-accent); opacity: 0.85; }
    .card.hero .v { font-size: 17px; font-weight: 600; }
  </style>
</head>
<body>
  <div class="topbar">
    <div class="brand"><span class="mark">&lt;0||0&gt;</span> Run Inspector</div>
    <span id="runlabel" class="runlabel"></span>
    <span id="badge" class="badge idle">idle</span>
  </div>
  <div class="image-host">
    <img id="preview-a" class="preview" alt="frame preview A" style="opacity:0" />
    <img id="preview-b" class="preview" alt="frame preview B" style="opacity:0" />
    <div id="placeholder" class="placeholder">
      <span class="mark">&lt;0||0&gt;</span>
      <span class="hint" id="m-hint">No solve in progress — fire one from the Amicode chat, or run “Replay demo run”.</span>
    </div>
  </div>
  <div class="metrics">
    <div class="card hero"><div class="k" id="m-obj-k">objective</div><div class="v" id="m-obj">–</div></div>
    <div class="card"><div class="k">iteration</div><div class="v" id="m-iter">–</div></div>
    <div class="card"><div class="k">feasibility</div><div class="v" id="m-pr">–</div></div>
    <div class="card"><div class="k">optimality</div><div class="v" id="m-du">–</div></div>
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

export function registerRunInspector(ctx: vscode.ExtensionContext, runsRoot: string): InspectorView {
  INSPECTOR = new InspectorView(ctx, runsRoot);
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
