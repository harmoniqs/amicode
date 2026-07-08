import * as vscode from "vscode";
import * as path from "node:path";
import { inspectorResourceRootDirs } from "./opencode_paths";
import type { PulseEvent, PulseMeta, PulseRecord } from "./run_dir_reader";

// ============================================================================
// Run Inspector — bottom-panel webview showing the live pulse-plot stream +
// an AMICODE_ITER stats row.
//
// 1.3 (#58): multi-run. The host↔webview message protocol is now runId-keyed
// (freeze 2 = the protocol, not the DOM): every message carries `runId`, the
// host keeps ONE buffer per runId, and the webview keeps ONE pane per runId.
// RunsManager fans ALL runs in here runId-tagged and calls activate(runId) to
// pick the visible pane. Per-run buffers make reopen (S36 buffer+replay) rebuild
// EVERY pane, not just the active one; the 5 Hz pulse throttle is per-run so a
// fast background run can't starve the foreground.
//
// Ported from the β single-run view (throttled record swap + native pulse #66).
// ============================================================================

const REFRESH_INTERVAL_MS = 200; // 5 Hz cap on pulse-record refresh (per run)

/** Timing payload for the elapsed/rate/ETA strip. */
export interface TimingInfo {
  createdAtMs?: number; // run.toml created_at → live elapsed base
  maxIter?: number; // parsed from the run script → ETA
  wallSeconds?: number; // result.toml wall_seconds → frozen elapsed on finish
  terminal?: boolean; // true once the run is finished
}

let INSPECTOR: InspectorView | undefined;

/** Everything replayable about one run's pane. Kept current whether or not the
 *  webview exists, so resolveWebviewView can rebuild the pane on reopen (S36).
 *  `pulseTimer`/`pendingPulse` are live-only throttle state (per run). */
interface PaneBuffer {
  runId: string;
  runLabel?: string;
  tags?: string[];
  warming: boolean;
  completion?: { status: string; fidelity?: number };
  pulseMeta?: PulseMeta;
  pulseRecord?: PulseRecord; // newest record (throttle coalesces to this)
  iterRecord?: { iter: number; f_val: number; kkt_error: number; eq_viol: number; ineq_viol: number; rho: number };
  timing?: TimingInfo; // elapsed/rate/ETA strip state (his run_timing UI)
  pulseTimer?: NodeJS.Timeout;
  pendingPulse?: PulseRecord;
}

class InspectorView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  /** One buffer per runId — the multi-run state. */
  private readonly panes = new Map<string, PaneBuffer>();
  /** The run whose pane is visible. Buffered until the webview materializes so
   *  a late-opened panel still lands on the right pane. */
  private activeRunId?: string;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  private paneFor(runId: string): PaneBuffer {
    let p = this.panes.get(runId);
    if (!p) {
      p = { runId, warming: false };
      this.panes.set(runId, p);
    }
    return p;
  }

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
    // the target run from the manager's selected run.
    const msgSub = view.webview.onDidReceiveMessage((msg: { type?: string; action?: string }) => {
      if (msg?.type !== "control") return;
      const cmd = (
        { stop: "amicode.stopRun", save: "amicode.savePulse", open: "amicode.openRunDir" } as Record<string, string>
      )[msg.action ?? ""];
      if (cmd) void vscode.commands.executeCommand(cmd);
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this.clearAllTimers();
      msgSub.dispose();
    });

    // S36 replay: rebuild EVERY pane from its buffer (not just the active one),
    // so switching to a background run after reopen shows its state too. Per
    // pane the order mirrors the live stream: runlabel → timing → warming →
    // pulsemeta → pulse → iteration → completed (terminal stays the last word).
    for (const p of this.panes.values()) this.replayPane(view, p);
    // Then pick the visible pane. activate is idempotent and last, so it wins
    // regardless of pane-replay order above.
    if (this.activeRunId) view.webview.postMessage({ type: "activate", runId: this.activeRunId });
  }

  private replayPane(view: vscode.WebviewView, p: PaneBuffer): void {
    const rid = p.runId;
    if (p.runLabel !== undefined) view.webview.postMessage({ type: "runlabel", runId: rid, text: p.runLabel });
    if (p.tags) view.webview.postMessage({ type: "tags", runId: rid, tags: p.tags });
    if (p.timing) view.webview.postMessage({ type: "timing", runId: rid, ...p.timing });
    if (p.warming) view.webview.postMessage({ type: "warming", runId: rid });
    if (p.pulseMeta) view.webview.postMessage({ type: "pulsemeta", runId: rid, ...p.pulseMeta });
    if (p.pulseRecord) view.webview.postMessage({ type: "pulse", runId: rid, ...p.pulseRecord });
    if (p.iterRecord) view.webview.postMessage({ type: "iteration", runId: rid, ...p.iterRecord, t_post: Date.now() });
    if (p.completion)
      view.webview.postMessage({
        type: "completed",
        runId: rid,
        status: p.completion.status,
        fidelity: p.completion.fidelity,
      });
  }

  // -------- public surface used by RunsManager (all runId-keyed) --------

  postIterationRecord(runId: string, rec: { iter: number; f_val: number; inf_pr: number; inf_du: number }): void {
    const p = this.paneFor(runId);
    p.warming = false;
    p.iterRecord = {
      iter: rec.iter,
      f_val: rec.f_val,
      kkt_error: rec.inf_du,
      eq_viol: rec.inf_pr,
      ineq_viol: 0,
      rho: 1.0,
    };
    if (!this.view) return; // buffered above; reopen replays it
    this.view.webview.postMessage({ type: "iteration", runId, ...p.iterRecord, t_post: Date.now() });
  }

  /** Terminal-state signal (badge stops saying "running") — on live finish AND
   *  when a run is selected already-finished. Buffered per run for reopen. */
  postCompletion(runId: string, status: string, fidelity?: number): void {
    const p = this.paneFor(runId);
    p.warming = false;
    p.completion = { status, fidelity };
    if (!this.view) return;
    this.view.webview.postMessage({ type: "completed", runId, status, fidelity });
  }

  /** A run started but has no data yet (Julia warming up) — show that instead of
   *  an idle pane, so a ~minute of cold start doesn't read as frozen. */
  setWarmingUp(runId: string): void {
    const p = this.paneFor(runId);
    // Warming means "no data yet". Never clobber a pane that already has terminal
    // state or streamed data (a run selected after its pipeline fanned events in,
    // or the stale-warming-after-completion race).
    if (p.completion || p.iterRecord || p.pulseRecord) return;
    p.warming = true;
    if (!this.view) {
      // Buffered in the pane regardless (shows when the user opens the panel);
      // only steal focus when the auto-open setting is enabled (his UX gate).
      if (autoOpenEnabled()) {
        vscode.commands.executeCommand("amicode.runInspector.focus").then(undefined, () => undefined);
      }
      return;
    }
    this.view.webview.postMessage({ type: "warming", runId });
  }

  /** Pulse-stream event (#66) → pulsemeta/pulse messages, runId-tagged. Meta is
   *  posted once; records are throttled to 5 Hz PER RUN (leading edge posts, the
   *  window coalesces newest-wins, trailing edge flushes). The newest record is
   *  always kept in the buffer for reopen even while the window is open. */
  postPulse(runId: string, e: PulseEvent): void {
    const p = this.paneFor(runId);
    // NB: unlike postIterationRecord/postCompletion this deliberately does NOT
    // clear p.warming — pulse is plot-only (#67), and the warming badge is
    // iter-driven. setWarmingUp already treats a present pulseRecord as "has
    // data", so a pulse still blocks a re-warm; the flag just isn't flipped here.
    if (e.type === "meta") {
      p.pulseMeta = e.meta;
      if (this.view) this.view.webview.postMessage({ type: "pulsemeta", runId, ...e.meta });
      return;
    }
    // record
    p.pulseRecord = e.record; // newest wins for reopen replay
    if (!this.view) return;
    if (p.pulseTimer) {
      p.pendingPulse = e.record;
      return;
    } // window open — coalesce
    this.view.webview.postMessage({ type: "pulse", runId, ...e.record });
    p.pulseTimer = setTimeout(() => {
      p.pulseTimer = undefined;
      if (p.pendingPulse && this.view) {
        const rec = p.pendingPulse;
        p.pendingPulse = undefined;
        this.postPulse(runId, { type: "record", record: rec });
      }
    }, REFRESH_INTERVAL_MS);
  }

  /** Set a run's topbar label (runId). Buffered per run until materialize. */
  setRunLabel(runId: string, label: string): void {
    this.paneFor(runId).runLabel = label;
    if (this.view) this.view.webview.postMessage({ type: "runlabel", runId, text: label });
  }

  /** Pulse tags (#49, UX4). Not sourced from any real run schema yet (Phase-3
   *  CatalogStore question) — real plumbing, ready for whenever a tag INPUT
   *  exists; no fake caller wired in this seam-prototype PR. Buffered per run
   *  until materialize, like every other pane field. */
  postTags(runId: string, tags: string[]): void {
    this.paneFor(runId).tags = tags;
    if (this.view) this.view.webview.postMessage({ type: "tags", runId, tags });
  }

  /** Timing for the elapsed/rate/ETA strip (ported from the single-run host —
   *  now runId-keyed + pane-buffered like every other message). */
  postTiming(runId: string, t: TimingInfo): void {
    const p = this.paneFor(runId);
    p.timing = { ...p.timing, ...t };
    if (this.view) this.view.webview.postMessage({ type: "timing", runId, ...p.timing });
  }

  /** Make `runId` the visible pane (1.3 selection seam). Buffered until the
   *  webview materializes; resolveWebviewView replays it last. */
  activate(runId: string): void {
    this.paneFor(runId); // ensure a pane exists even before any data
    this.activeRunId = runId;
    if (this.view) this.view.webview.postMessage({ type: "activate", runId });
  }

  reveal(): void {
    // Auto-reveal only when opted in (amicode.inspector.autoOpen). Off by
    // default so a starting solve never steals focus; the status-bar item and
    // the explicit open command (which bypasses reveal) remain available.
    if (!autoOpenEnabled()) return;
    vscode.commands.executeCommand("amicode.runInspector.focus").then(undefined, () => undefined);
  }

  // -------- internal --------

  private clearAllTimers(): void {
    for (const p of this.panes.values()) {
      if (p.pulseTimer) {
        clearTimeout(p.pulseTimer);
        p.pulseTimer = undefined;
      }
      p.pendingPulse = undefined;
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const uri = (...parts: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, ...parts));
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
             style-src ${webview.cspSource} 'unsafe-inline';
             font-src ${webview.cspSource};">
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
