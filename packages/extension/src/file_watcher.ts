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

const AMICODE_ITER_RE = /^AMICODE_ITER\s+iter=(\d+)\s+f=(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s+inf_pr=(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s+inf_du=(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*$/;

export class RunsRootWatcher implements vscode.Disposable {
  private rootWatcher?: fs.FSWatcher;
  private activeRunDir?: string;
  private activeRunWatcher?: fs.FSWatcher;
  private logTailer?: LogTailer;
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
    this.logTailer?.dispose();
    this.rootWatcher = undefined;
    this.activeRunWatcher = undefined;
    this.logTailer = undefined;
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
    this.logTailer?.dispose();
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

    // Tail run.log for AMICODE_ITER records → drives the Inspector stats row.
    this.logTailer = new LogTailer({
      path: path.join(runDir, "run.log"),
      channel: this.opts.channel,
      onLine: (line) => this.onLogLine(line),
    });
    this.logTailer.start();
  }

  private onLogLine(line: string): void {
    const m = AMICODE_ITER_RE.exec(line);
    if (!m) return;
    getInspector()?.postIterationRecord({
      iter:   parseInt(m[1], 10),
      f_val:  parseFloat(m[2]),
      inf_pr: parseFloat(m[3]),
      inf_du: parseFloat(m[4]),
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

// ===========================================================================
// LogTailer — follows run.log as julia appends to it, emits each new line via
// onLine. Uses fs.watch + fs.read at the persisted offset; survives the file
// not existing yet (amico-run touches it lazily via tee).
// ===========================================================================

interface LogTailerOptions {
  path: string;
  channel: vscode.OutputChannel;
  onLine: (line: string) => void;
}

class LogTailer implements vscode.Disposable {
  private watcher?: fs.FSWatcher;
  private offset = 0;
  private buf = "";
  private pollTimer?: NodeJS.Timeout;
  private disposed = false;

  constructor(private readonly opts: LogTailerOptions) {}

  start(): void {
    // The log file may not exist yet (amico-run creates it via `tee`). Poll
    // for it briefly; once it appears, switch to fs.watch.
    const tryAttach = () => {
      if (this.disposed) return;
      if (fs.existsSync(this.opts.path)) {
        this.attach();
      } else {
        this.pollTimer = setTimeout(tryAttach, 250);
      }
    };
    tryAttach();
  }

  dispose(): void {
    this.disposed = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    try { this.watcher?.close(); } catch { /* noop */ }
    this.watcher = undefined;
  }

  private attach(): void {
    if (this.disposed) return;
    try {
      this.watcher = fs.watch(this.opts.path, { persistent: false }, (event) => {
        if (event === "change") this.drain();
      });
    } catch (err) {
      this.opts.channel.appendLine(`[runs] log tail attach failed: ${(err as Error).message}`);
      return;
    }
    // Initial read in case content already exists.
    this.drain();
  }

  private drain(): void {
    if (this.disposed) return;
    let fd: number;
    try {
      fd = fs.openSync(this.opts.path, "r");
    } catch { return; }
    try {
      const stat = fs.fstatSync(fd);
      const size = stat.size;
      if (size < this.offset) {
        // File was truncated (or replaced by a newer run somehow).
        this.offset = 0;
        this.buf = "";
      }
      if (size === this.offset) return;
      const chunk = Buffer.allocUnsafe(size - this.offset);
      const read = fs.readSync(fd, chunk, 0, chunk.length, this.offset);
      this.offset += read;
      this.buf += chunk.subarray(0, read).toString("utf8");
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        try { this.opts.onLine(line); }
        catch (e) { this.opts.channel.appendLine(`[runs] onLine threw: ${String(e)}`); }
      }
    } finally {
      try { fs.closeSync(fd); } catch { /* noop */ }
    }
  }
}
