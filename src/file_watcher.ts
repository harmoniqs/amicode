import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { getInspector } from "./run_inspector";

// ============================================================================
// File watcher — when a solve is in flight, watches the run output dir for:
//   iter_NNNN.png   → Run Inspector image refresh
//   final.png       → final-frame Inspector refresh
//   formulation.md  → auto-open VS Code markdown preview side-by-side
//   FINISHED        → signals end-of-solve
//   solve.log       → append-to-output passthrough (handled elsewhere)
//
// Note on safe process usage: this module does NOT spawn subprocesses; all
// IPC is via fs.watch. spike_solve.jl spawn lives in amico-mcp (mcp/index.ts).
//
// Ported from amicode/src/spikes/spike_c_solve.ts startWatcher() with the
// chat-handler-driven runSolve stripped.
// ============================================================================

export class RunOutputWatcher implements vscode.Disposable {
  private watcher?: fs.FSWatcher;
  private latestIter = -1;
  private formulationOpened = false;

  constructor(public readonly outputDir: string) {}

  start(): void {
    fs.mkdirSync(this.outputDir, { recursive: true });
    this.watcher = fs.watch(this.outputDir, { persistent: false }, (event, filename) => {
      if (!filename) return;
      if (event !== "rename" && event !== "change") return;
      const fp = path.join(this.outputDir, filename);
      if (!fs.existsSync(fp)) return;
      this.handle(filename, fp);
    });
  }

  dispose(): void {
    try { this.watcher?.close(); } catch {}
    this.watcher = undefined;
  }

  private handle(filename: string, fp: string): void {
    const iterMatch = /^iter_(\d{4})\.png$/.exec(filename);
    if (iterMatch) {
      const iter = parseInt(iterMatch[1], 10);
      if (iter <= this.latestIter) return;
      this.latestIter = iter;
      getInspector()?.setImageSource(fp, iter);
      return;
    }
    if (filename === "final.png") {
      getInspector()?.setImageSource(fp, this.latestIter + 1, /*final*/ true);
      return;
    }
    if (filename === "formulation.md" && !this.formulationOpened) {
      this.formulationOpened = true;
      vscode.commands
        .executeCommand("markdown.showPreviewToSide", vscode.Uri.file(fp))
        .then(undefined, (err) => console.warn("[amicode/watcher] formulation preview failed:", err));
      return;
    }
  }
}
