import * as vscode from "vscode";

// ============================================================================
// StatusBarManager — minimal server-ready indicator. The live-solve indicator
// (iter/fidelity) is removed in #351 — the Work Column Run Inspector tab is
// now the sole surface for solve status.
// ============================================================================

export function statusBarLabel(serverReady: boolean): { text: string; tooltip: string } {
  if (!serverReady) return { text: "$(loading~spin) Amicode (booting)", tooltip: "Spawning opencode server…" };
  return { text: "$(comment-discussion) Amicode", tooltip: "Amicode — chat + Work Column inspectors" };
}

export class StatusBarManager {
  private readonly item: vscode.StatusBarItem;
  private serverReady = false;

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

  dispose(): void {
    this.item.dispose();
  }

  private render(): void {
    const { text, tooltip } = statusBarLabel(this.serverReady);
    this.item.text = text;
    this.item.tooltip = tooltip;
  }
}
