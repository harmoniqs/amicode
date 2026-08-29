import * as vscode from "vscode";
import type { SseState } from "./sse_liveness";

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
): { text: string; tooltip: string } {
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

  dispose(): void {
    this.item.dispose();
  }

  private render(): void {
    const { text, tooltip } = statusBarLabel(this.serverReady, this.sseState);
    this.item.text = text;
    this.item.tooltip = tooltip;
  }
}
