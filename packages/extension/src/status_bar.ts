import * as vscode from "vscode";
import type { RunState } from "./types";

// ============================================================================
// StatusBarManager — small status-bar item summarising server + active run.
// Updated by the rest of the extension via setServerState / setRunState.
// ============================================================================

/** Pure label/tooltip for the status-bar item — unit-tested without VSCode. */
export function statusBarLabel(serverReady: boolean, run?: RunState): { text: string; tooltip: string } {
  if (!serverReady) return { text: "$(loading~spin) Amicode (booting)", tooltip: "Spawning opencode server…" };
  const dir = run?.outputDir ?? "";
  switch (run?.status) {
    case "starting": return { text: "$(sync~spin) Amicode · warming…", tooltip: `Julia warming up in ${dir}` };
    case "running":  return { text: `$(gear~spin) Amicode · iter ${run.latestIter ?? "—"}`, tooltip: `Solve running in ${dir}` };
    case "completed": {
      const f = run.fidelity;
      return { text: `$(check) Amicode · F=${f !== undefined ? f.toFixed(4) : "—"}`, tooltip: `Last solve completed in ${dir}` };
    }
    case "stopped":  return { text: "$(circle-slash) Amicode · stopped", tooltip: `Solve stopped in ${dir}` };
    case "failed":   return { text: "$(error) Amicode · solve failed", tooltip: `Solve failed in ${dir} — see run.log` };
    case "aborted":  return { text: "$(circle-slash) Amicode · aborted", tooltip: `Solve aborted in ${dir}` };
    default:         return { text: "$(comment-discussion) Amicode", tooltip: "Open the Run Inspector" };
  }
}

export class StatusBarManager {
  private readonly item: vscode.StatusBarItem;
  private serverReady = false;
  private run?: RunState;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    // A run-state item → clicking opens the run view (the Run Inspector).
    this.item.command = "amicode.openInspector";
    this.item.show();
    this.render();
  }

  setServerReady(ready: boolean): void {
    this.serverReady = ready;
    this.render();
  }

  setRun(run: RunState | undefined): void {
    this.run = run;
    this.render();
  }

  dispose(): void {
    this.item.dispose();
  }

  private render(): void {
    const { text, tooltip } = statusBarLabel(this.serverReady, this.run);
    this.item.text = text;
    this.item.tooltip = tooltip;
  }
}
