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
    const uri = (...parts: string[]) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, ...parts));
    const nonce = newNonce();
    // The view is TS-composed (media/ui/views/inspector.ts → dist bundle): the
    // script builds its own DOM from atoms/components and injects their styles
    // via constructable stylesheets (not CSP-governed). This method owns only
    // the security/wiring shell: CSP, nonce, and the brand/layout stylesheet
    // URIs. The shell⇄view seam is pinned by inspector_view_contract.test.ts.
    //
    // style-src keeps 'unsafe-inline' deliberately — the view sets element
    // .style properties at runtime (buffer opacity flips, placeholder toggle);
    // those aren't CSP-governed, but keeping the grant future-proofs static
    // style attrs the design lane may add. img-src carries the runs-root via
    // localResourceRoots for iter-frame PNGs.
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             img-src ${webview.cspSource} data: blob: https:;
             script-src 'nonce-${nonce}';
             style-src ${webview.cspSource} 'unsafe-inline';">
  <link rel="stylesheet" href="${uri("media", "brand.css")}" />
  <link rel="stylesheet" href="${uri("media", "layout.css")}" />
</head>
<body>
  <script nonce="${nonce}" src="${uri("dist", "inspector_webview.js")}"></script>
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
