import * as vscode from "vscode";
import type { RunState } from "./types";

// ============================================================================
// StatusBarManager — small status-bar item summarising server + active run.
// Updated by the rest of the extension via setServerState / setRunState.
// ============================================================================

export class StatusBarManager {
  private readonly item: vscode.StatusBarItem;
  private serverReady = false;
  private run?: RunState;

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

  setRun(run: RunState | undefined): void {
    this.run = run;
    this.render();
  }

  dispose(): void {
    this.item.dispose();
  }

  private render(): void {
    if (!this.serverReady) {
      this.item.text = "$(loading~spin) Amicode (booting)";
      this.item.tooltip = "Spawning opencode server…";
      return;
    }
    if (this.run && this.run.status === "running") {
      this.item.text = `$(gear~spin) Amicode · iter ${this.run.latestIter ?? "—"}`;
      this.item.tooltip = `Solve running in ${this.run.outputDir}`;
      return;
    }
    if (this.run && this.run.status === "completed") {
      const f = this.run.fidelity;
      this.item.text = `$(check) Amicode · F=${f !== undefined ? f.toFixed(4) : "—"}`;
      this.item.tooltip = `Last solve completed in ${this.run.outputDir}`;
      return;
    }
    if (this.run && this.run.status === "failed") {
      this.item.text = "$(error) Amicode · solve failed";
      this.item.tooltip = `Solve failed in ${this.run.outputDir} — see run.log`;
      return;
    }
    if (this.run && this.run.status === "aborted") {
      this.item.text = "$(circle-slash) Amicode · aborted";
      this.item.tooltip = `Solve aborted in ${this.run.outputDir}`;
      return;
    }
    this.item.text = "$(comment-discussion) Amicode";
    this.item.tooltip = "Open Amicode chat";
  }
}
