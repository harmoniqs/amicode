import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { getInspector } from "./run_inspector";
import type { StatusBarManager } from "./status_bar";

// ============================================================================
// RunsRootWatcher — the heart of the v2 CLI-direct architecture.
//
// Sits on /tmp/amicode-runs/ and watches for:
//   - new run subdirs (created by amico-run via mkdir + symlink swap)
//   - the `latest` symlink target changing
//   - per-run files inside the active run dir:
//        .start              → run lifecycle begin
//        iter_NNNN.png       → push to Run Inspector
//        formulation.md      → auto-open markdown side preview
//        result.toml         → final fidelity → promote-to-catalog QuickPick
//        FINISHED            → release the run dir watcher
//
// We follow the `latest` symlink — when amico-run swings it, we re-target.
// This keeps the watcher logic stateless w.r.t. who told us about the run;
// no callback HTTP, no MCP, no event propagation across process boundaries.
// ============================================================================

export interface RunsRootWatcherOptions {
  runsRoot: string;
  channel: vscode.OutputChannel;
  statusBar?: StatusBarManager;
  /** Fidelity threshold (≥) at which to prompt promotion. Default 0.99. */
  promoteThreshold?: number;
}

export class RunsRootWatcher implements vscode.Disposable {
  private rootWatcher?: fs.FSWatcher;
  private activeRunDir?: string;
  private activeRunWatcher?: fs.FSWatcher;
  private latestIter = -1;
  private formulationOpened = false;
  private promotedForRun = false;

  constructor(private readonly opts: RunsRootWatcherOptions) {}

  start(): void {
    fs.mkdirSync(this.opts.runsRoot, { recursive: true });
    // Pick up an in-progress or just-completed run if `latest` already exists.
    const latest = path.join(this.opts.runsRoot, "latest");
    if (fs.existsSync(latest)) this.followLatest();

    this.rootWatcher = fs.watch(this.opts.runsRoot, { persistent: false }, (_event, filename) => {
      if (filename === "latest") this.followLatest();
    });
    this.opts.channel.appendLine(`[runs] watching ${this.opts.runsRoot}`);
  }

  dispose(): void {
    try { this.rootWatcher?.close(); } catch { /* noop */ }
    try { this.activeRunWatcher?.close(); } catch { /* noop */ }
    this.rootWatcher = undefined;
    this.activeRunWatcher = undefined;
  }

  // ---------------------------------------------------------------------

  private followLatest(): void {
    const latest = path.join(this.opts.runsRoot, "latest");
    let target: string | undefined;
    try {
      target = fs.realpathSync(latest);
    } catch (err) {
      this.opts.channel.appendLine(`[runs] latest unresolved: ${(err as Error).message}`);
      return;
    }
    if (target === this.activeRunDir) return;
    this.opts.channel.appendLine(`[runs] active run -> ${target}`);
    this.switchToRun(target);
  }

  private switchToRun(runDir: string): void {
    try { this.activeRunWatcher?.close(); } catch { /* noop */ }
    this.activeRunDir = runDir;
    this.latestIter = -1;
    this.formulationOpened = false;
    this.promotedForRun = false;

    // Reveal the inspector so the user sees the new run start.
    getInspector()?.reveal();
    this.opts.statusBar?.setRun({
      runId: path.basename(runDir),
      outputDir: runDir,
      startedAt: Date.now(),
      status: "running",
    });

    // Replay any files that already exist (we may be late to the run).
    try {
      for (const f of fs.readdirSync(runDir)) {
        this.handle(f, path.join(runDir, f));
      }
    } catch (err) {
      this.opts.channel.appendLine(`[runs] readdir failed: ${(err as Error).message}`);
    }

    this.activeRunWatcher = fs.watch(runDir, { persistent: false }, (_event, filename) => {
      if (!filename) return;
      const fp = path.join(runDir, filename);
      if (!fs.existsSync(fp)) return;
      this.handle(filename, fp);
    });
  }

  private handle(filename: string, fp: string): void {
    const iterMatch = /^iter_(\d{4})\.png$/.exec(filename);
    if (iterMatch) {
      const iter = parseInt(iterMatch[1], 10);
      if (iter <= this.latestIter) return;
      this.latestIter = iter;
      getInspector()?.setImageSource(fp, iter);
      this.opts.statusBar?.setRun({
        runId: path.basename(this.activeRunDir!),
        outputDir: this.activeRunDir!,
        startedAt: 0,
        status: "running",
        latestIter: iter,
      });
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
        .then(undefined, (err) => this.opts.channel.appendLine(`[runs] preview failed: ${err}`));
      return;
    }
    if (filename === "result.toml") {
      this.onResult(fp);
      return;
    }
  }

  private onResult(resultPath: string): void {
    if (this.promotedForRun) return;
    let txt = "";
    try { txt = fs.readFileSync(resultPath, "utf8"); }
    catch { return; }
    const fid = parseFloat(((txt.match(/fidelity\s*=\s*([\d.eE+-]+)/) ?? [])[1] ?? ""));
    if (!Number.isFinite(fid)) return;

    this.opts.statusBar?.setRun({
      runId: path.basename(this.activeRunDir!),
      outputDir: this.activeRunDir!,
      startedAt: 0,
      status: "completed",
      latestIter: this.latestIter,
    });
    this.opts.channel.appendLine(`[runs] result.toml: F=${fid.toFixed(6)}`);

    const threshold = this.opts.promoteThreshold ?? 0.99;
    if (fid < threshold) return;
    this.promotedForRun = true;

    void (async () => {
      const choice = await vscode.window.showInformationMessage(
        `Amicode: solve converged (F=${fid.toFixed(4)}). Promote pulse to catalog?`,
        { modal: false },
        "Yes — promote",
        "No — keep local only",
      );
      if (choice === "Yes — promote") {
        // Catalog write isn't wired yet — toast for now.
        vscode.window.showInformationMessage(
          `Amicode: promotion stub — would copy ${path.basename(this.activeRunDir!)} to catalog.`,
        );
        await vscode.commands.executeCommand("amicode.catalog.refresh").then(undefined, () => undefined);
      }
    })();
  }
}
