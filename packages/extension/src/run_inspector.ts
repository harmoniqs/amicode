import * as vscode from "vscode";
import * as path from "node:path";
import { inspectorResourceRootDirs } from "./opencode_paths";
import type { PulseEvent, PulseMeta, PulseRecord } from "./run_dir_reader";

// ============================================================================
// Run Inspector — bottom-panel webview that shows the live pulse-plot stream
// from spike_solve.jl plus a stats row driven by AMICODE_ITER parsing.
//
// Ported from amicode/src/spikes/spike_b_inspector.ts with the simulation
// experiments stripped (we don't need ping/sim now that we have a real run
// path). Keeps the throttled image swap + setImageSource / postIteration API.
// ============================================================================

const REFRESH_INTERVAL_MS = 200; // 5 Hz cap on pulse-record refresh

let INSPECTOR: InspectorView | undefined;

class InspectorView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  /** Terminal state that arrived before the webview existed (e.g. on launch the
   *  watcher follows `latest` → a finished run completes before the panel is
   *  opened). Replayed after buffered pulse data so the badge isn't stuck "running". */
  private bufferedCompletion?: { status: string; fidelity?: number };
  /** A run started but hasn't emitted its first frame yet (Julia warming up).
   *  Buffered so the warming state shows even if the panel opens late. */
  private bufferedWarming = false;
  /** Run label (runId) for the topbar — buffered so it shows even if the panel
   *  opens after the run was selected. */
  private bufferedRunLabel?: string;
  /** Pulse events that arrived before the webview existed (#66 AC7). Unlike
   *  PNGs (re-offered by the poll forever), the log line is the canonical
   *  signal — dropped means gone. Meta + NEWEST record only. */
  private bufferedPulseMeta?: PulseMeta;
  private bufferedPulseRecord?: PulseRecord;
  /** 5 Hz throttle for live pulse records — same REFRESH_INTERVAL_MS policy as
   *  PNG frames: leading edge posts, the window coalesces (newest wins), the
   *  trailing edge flushes. Meta is never throttled (once per run). */
  private pulseTimer?: NodeJS.Timeout;
  private pendingPulse?: PulseRecord;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      // Extension assets only — the view renders from message data (#66);
      // no run-dir or workspace file access is needed.
      localResourceRoots: inspectorResourceRootDirs(this.ctx.extensionUri.fsPath).map((d) => vscode.Uri.file(d)),
    };
    view.webview.html = this.renderHtml(view.webview);

    // Control row (Stop / Save pulse / Open dir): the view posts
    // {type:"control", action}; forward to the matching command, which resolves
    // the target run from the watcher's activeRunDir.
    const msgSub = view.webview.onDidReceiveMessage((msg: { type?: string; action?: string }) => {
      if (msg?.type !== "control") return;
      const cmd = ({ stop: "amicode.stopRun", save: "amicode.savePulse", open: "amicode.openRunDir" } as Record<string, string>)[msg.action ?? ""];
      if (cmd) void vscode.commands.executeCommand(cmd);
    });
    view.onDidDispose(() => { this.view = undefined; this.clearPulseTimer(); msgSub.dispose(); });

    // Topbar run label — replay first so it's set regardless of run state.
    if (this.bufferedRunLabel) {
      view.webview.postMessage({ type: "runlabel", text: this.bufferedRunLabel });
      this.bufferedRunLabel = undefined;
    }
    // A run is warming up (no data yet) — show that until the first record.
    if (this.bufferedWarming) {
      this.bufferedWarming = false;
      view.webview.postMessage({ type: "warming" });
    }
    // Replay buffered pulse events (#66): meta first, then the newest record —
    // and BEFORE the buffered completion below, so terminal state stays the
    // last word the webview hears.
    if (this.bufferedPulseMeta) {
      view.webview.postMessage({ type: "pulsemeta", ...this.bufferedPulseMeta });
      this.bufferedPulseMeta = undefined;
    }
    if (this.bufferedPulseRecord) {
      view.webview.postMessage({ type: "pulse", ...this.bufferedPulseRecord });
      this.bufferedPulseRecord = undefined;
    }
    // Then replay a terminal state if the run already finished — after the
    // pulse data so "converged"/"failed" is the last word the webview hears.
    if (this.bufferedCompletion) {
      const c = this.bufferedCompletion;
      this.bufferedCompletion = undefined;
      view.webview.postMessage({ type: "completed", status: c.status, fidelity: c.fidelity });
    }
  }

  // -------- public surface used by RunsRootWatcher --------

  postIterationRecord(rec: { iter: number; f_val: number; inf_pr: number; inf_du: number }): void {
    // Ok to drop iter records pre-materialization: the stats row refreshes on
    // the next record (seconds away), and switchToRun's log replay re-ingests
    // history whenever the run is re-selected. (Pulse events, by contrast, are
    // buffered above — the log line is their only delivery.)
    if (!this.view) return;
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

  /** Terminal-state signal so the badge stops saying "running" — on live
   *  finish AND when switching to an already-finished run. */
  postCompletion(status: string, fidelity?: number): void {
    if (!this.view) {
      // Panel not open yet — stash; resolveWebviewView replays it after pulse data.
      this.bufferedCompletion = { status, fidelity };
      return;
    }
    this.view.webview.postMessage({ type: "completed", status, fidelity });
  }

  /** A run started but has no data yet (Julia warming up) — show that instead
   *  of an idle panel, so a ~minute of cold start doesn't read as frozen. */
  setWarmingUp(): void {
    if (!this.view) {
      // Buffer the warming state regardless — so it shows when the user DOES
      // open the panel — but only steal focus when auto-open is enabled.
      this.bufferedWarming = true;
      if (autoOpenEnabled()) {
        vscode.commands.executeCommand("amicode.runInspector.focus").then(undefined, () => undefined);
      }
      return;
    }
    this.view.webview.postMessage({ type: "warming" });
  }

  /** Pulse-stream event (#66): forwarded to the view as pulsemeta/pulse
   *  messages. Buffering for late materialization lands with AC7. */
  postPulse(e: PulseEvent): void {
    if (!this.view) {
      // Buffer (newest record wins) — replayed in resolveWebviewView.
      if (e.type === "meta") this.bufferedPulseMeta = e.meta;
      else this.bufferedPulseRecord = e.record;
      return;
    }
    if (e.type === "meta") { this.view.webview.postMessage({ type: "pulsemeta", ...e.meta }); return; }
    if (this.pulseTimer) { this.pendingPulse = e.record; return; }   // window open — coalesce, newest wins
    this.view.webview.postMessage({ type: "pulse", ...e.record });
    this.pulseTimer = setTimeout(() => {
      this.pulseTimer = undefined;
      if (this.pendingPulse && this.view) {
        const rec = this.pendingPulse;
        this.pendingPulse = undefined;
        this.postPulse({ type: "record", record: rec });
      }
    }, REFRESH_INTERVAL_MS);
  }

  /** Set the topbar run label (runId). Buffered until the webview materializes. */
  setRunLabel(label: string): void {
    if (!this.view) { this.bufferedRunLabel = label; return; }
    this.view.webview.postMessage({ type: "runlabel", text: label });
  }

  reveal(): void {
    // Auto-reveal only when opted in (amicode.inspector.autoOpen). Off by
    // default so a starting solve never steals focus; the status-bar item and
    // the explicit open command (which bypasses reveal) remain available.
    if (!autoOpenEnabled()) return;
    vscode.commands.executeCommand("amicode.runInspector.focus")
      .then(undefined, () => undefined);
  }

  // -------- internal --------

  private clearPulseTimer(): void {
    if (this.pulseTimer) {
      clearTimeout(this.pulseTimer);
      this.pulseTimer = undefined;
    }
    this.pendingPulse = undefined;
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
    // .style properties at runtime; those aren't CSP-governed, but the grant
    // future-proofs static style attrs the design lane may add.
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
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

/** Whether a starting solve should auto-reveal the panel. Default off — the
 *  status-bar item / "Amicode: Open Run Inspector" are the on-demand entry
 *  points. The explicit open command bypasses reveal(), so it always works. */
export function autoOpenEnabled(): boolean {
  return vscode.workspace.getConfiguration("amicode").get<boolean>("inspector.autoOpen", false);
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
