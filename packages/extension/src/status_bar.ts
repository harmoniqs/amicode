import * as vscode from "vscode";
import type { SseState } from "./sse_liveness";
import type { WindowMode } from "./fleet_window_mode_state";

// ============================================================================
// StatusBarManager — the honest server/stream indicator. The live-solve
// indicator (iter/fidelity) is removed in #351 — the Work Column Run
// Inspector tab is the sole surface for solve status. The stream states (L1,
// #638) are evidence-backed: "thinking" is only ever true while the event
// stream is LIVE; a stalled stream says so instead of pretending.
// ============================================================================

export function statusBarLabel(
  serverReady: boolean,
  // default "live" preserves the historical ready-state label for callers
  // that only know the server is ready; the manager always passes the real
  // stream state (L1, #638)
  sseState: SseState = "live",
  // #1272 — the editor WINDOW mode (Remote-SSH vs local), an axis ORTHOGONAL to
  // server readiness / stream state. Reflected only when `remote-ssh`; `local`
  // / undefined leave the label untouched. NEVER the link-health `standalone`
  // token (AC1) — these are the window-mode values only.
  windowMode?: WindowMode,
  // #1571 — the adopted engine runs a different build/config than what is on
  // disk (what differs, e.g. "engine binary"). A PERSISTENT flag, unlike the
  // one-shot #1190 toast; additive to whatever the base label claims.
  engineStale?: string,
): { text: string; tooltip: string } {
  return reflectEngineStale(reflectWindowMode(baseLabel(serverReady, sseState), windowMode), engineStale);
}

/** Fold the stale-engine flag onto a computed label (additive; undefined = untouched). */
function reflectEngineStale(base: { text: string; tooltip: string }, detail?: string): { text: string; tooltip: string } {
  if (detail === undefined) return base;
  return {
    text: `${base.text} $(warning) engine stale`,
    tooltip: `${base.tooltip} · The running server's ${detail} differs from the current build — click to restart the engine onto it.`,
  };
}

/** Fold the window-mode axis onto a computed base label. Additive: a
 *  `remote-ssh` window adds a remote indicator to the text and a note to the
 *  tooltip; `local` / undefined pass the base through unchanged. Applied
 *  uniformly (including the booting state) — it is honest regardless of server
 *  readiness or stream health, and it never rewrites the base's own claim. */
function reflectWindowMode(base: { text: string; tooltip: string }, windowMode?: WindowMode): { text: string; tooltip: string } {
  if (windowMode !== "remote-ssh") return base;
  return { text: `${base.text} $(remote)`, tooltip: `${base.tooltip} · window: Remote-SSH` };
}

function baseLabel(serverReady: boolean, sseState: SseState): { text: string; tooltip: string } {
  if (!serverReady) return { text: "$(loading~spin) Amicode (booting)", tooltip: "Spawning opencode server…" };
  switch (sseState) {
    case "live":
      return { text: "$(comment-discussion) Amicode", tooltip: "Amicode — chat + Work Column inspectors" };
    case "stale":
      return {
        text: "$(debug-disconnect) Amicode — stream stalled",
        tooltip: "Event stream stalled — probing the harness, reconnecting if needed. A 'thinking' indicator is not truth right now.",
      };
    case "dead":
      return {
        text: "$(error) Amicode — server unreachable",
        tooltip: "Harness unreachable — reconnecting. Session state is preserved; work is not lost.",
      };
    case "connecting":
      return { text: "$(loading~spin) Amicode", tooltip: "Connecting to the harness event stream…" };
  }
}

export class StatusBarManager {
  private readonly item: vscode.StatusBarItem;
  private serverReady = false;
  private sseState: SseState = "connecting";
  private windowMode: WindowMode | undefined;
  private engineStale: string | undefined;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "amicode.openChat";
    this.item.show();
    this.render();
  }

  setServerReady(ready: boolean): void {
    this.serverReady = ready;
    this.render();
  }

  /** The stream's honest state (L1, #638) — driven by the SSE client's
   *  liveness transitions; boot states stay untouched. */
  setSseState(state: SseState): void {
    this.sseState = state;
    this.render();
  }

  /** The editor WINDOW mode (#1272) — Remote-SSH vs local, an axis orthogonal
   *  to server/stream state. Set once from the editor's remote indicator at
   *  activation; reflected in the label only when Remote-SSH. */
  setWindowMode(mode: WindowMode): void {
    this.windowMode = mode;
    this.render();
  }

  /** #1571: raise (detail) or clear (undefined) the persistent stale-engine
   *  indicator. While raised, a click restarts the engine instead of opening chat. */
  setEngineStale(detail: string | undefined): void {
    this.engineStale = detail;
    this.item.command = detail === undefined ? "amicode.openChat" : "amicode.restartStaleEngine";
    this.render();
  }

  dispose(): void {
    this.item.dispose();
  }

  private render(): void {
    const { text, tooltip } = statusBarLabel(this.serverReady, this.sseState, this.windowMode, this.engineStale);
    this.item.text = text;
    this.item.tooltip = tooltip;
  }
}
