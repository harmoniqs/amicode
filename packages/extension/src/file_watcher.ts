import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { validateFinished, validateResult } from "@amicode/amico-run";
import { getInspector } from "./run_inspector";
import type { StatusBarManager } from "./status_bar";
import type { RunStatus } from "./types";
import {
  AMICODE_ITER_RE, ITER_PNG_RE, ingestRunDir, readTomlSafe,
  type IterRecord, type RunCompletion, type PromoteInfo, type RunSink,
} from "./run_dir_reader";

// ============================================================================
// RunsRootWatcher — watches the β.1 run-dir contract and drives the Inspector
// + status bar. Follows the `latest` symlink; for the active run it reads:
//   manifest.toml  → run identity (run_id, lab_id), written FIRST
//   iter_<N>.png   → live plot frames (unbounded digits)
//   run.log        → AMICODE_ITER lines → live stats row
//   result.toml    → fidelity (display + promote gate), atomic
//   FINISHED       → authoritative terminal signal {status, exit_code}
//
// Completion keys on FINISHED (not result.toml). The contract-reading logic is
// the pure `ingestRunDir` in run_dir_reader.ts (replay/late-join, unit-tested);
// the live path here adds incremental fs.watch + run.log tailing.
// ============================================================================

export interface RunsRootWatcherOptions {
  runsRoot: string;
  channel: vscode.OutputChannel;
  statusBar?: StatusBarManager;
  promoteThreshold?: number;
}

/** Live sink: routes to the Inspector + status bar, carrying newest-wins and
 *  promote-once guards so replay-then-incremental never double-fires. */
class LiveRunSink implements RunSink {
  private latestIter = -1;
  private promoted = false;
  constructor(private readonly opts: RunsRootWatcherOptions) {}

  image(fsPath: string, iter: number): void {
    if (iter <= this.latestIter) return;
    this.latestIter = iter;
    getInspector()?.setImageSource(fsPath, iter);
  }
  iter(rec: IterRecord): void {
    getInspector()?.postIterationRecord(rec);
  }
  run(c: RunCompletion): void {
    this.opts.statusBar?.setRun({
      runId: c.runId, outputDir: c.runDir, startedAt: 0,
      status: c.status, latestIter: this.latestIter >= 0 ? this.latestIter : undefined,
      fidelity: c.fidelity,
    });
    this.opts.channel.appendLine(`[runs] ${c.runId} ${c.status}${c.fidelity !== undefined ? ` F=${c.fidelity.toFixed(6)}` : ""}`);
    if (c.status !== "completed") {
      this.opts.channel.appendLine(`[runs] see ${path.join(c.runDir, "run.log")}`);
    }
  }
  promote(info: PromoteInfo): void {
    if (this.promoted) return;
    this.promoted = true;
    void (async () => {
      const choice = await vscode.window.showInformationMessage(
        `Amicode: solve converged (F=${info.fidelity.toFixed(4)}). Promote pulse to catalog?`,
        "Yes — promote", "No — keep local only",
      );
      if (choice === "Yes — promote") {
        vscode.window.showInformationMessage(`Amicode: promotion stub — would catalog ${info.runId}.`);
        await vscode.commands.executeCommand("amicode.catalog.refresh").then(undefined, () => undefined);
      }
    })();
  }
}

export class RunsRootWatcher implements vscode.Disposable {
  private rootWatcher?: fs.FSWatcher;
  private activeRunDir?: string;
  private activeRunWatcher?: fs.FSWatcher;
  private logTailer?: LogTailer;
  private sink?: LiveRunSink;
  private finishedSeen = false;

  constructor(private readonly opts: RunsRootWatcherOptions) {}

  start(): void {
    fs.mkdirSync(this.opts.runsRoot, { recursive: true });
    const latest = path.join(this.opts.runsRoot, "latest");
    if (fs.existsSync(latest)) this.followLatest();
    this.rootWatcher = fs.watch(this.opts.runsRoot, { persistent: false }, (_e, filename) => {
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

  private followLatest(): void {
    let target: string | undefined;
    try { target = fs.realpathSync(path.join(this.opts.runsRoot, "latest")); }
    catch (err) { this.opts.channel.appendLine(`[runs] latest unresolved: ${(err as Error).message}`); return; }
    if (target === this.activeRunDir) return;
    this.opts.channel.appendLine(`[runs] active run -> ${target}`);
    this.switchToRun(target);
  }

  private switchToRun(runDir: string): void {
    try { this.activeRunWatcher?.close(); } catch { /* noop */ }
    this.logTailer?.dispose();
    this.activeRunDir = runDir;
    this.sink = new LiveRunSink(this.opts);

    getInspector()?.reveal();

    // Replay everything already on disk (late-join safe).
    try { ingestRunDir(runDir, this.sink, this.opts.promoteThreshold ?? 0.99); }
    catch (err) { this.opts.channel.appendLine(`[runs] replay failed: ${(err as Error).message}`); }
    this.finishedSeen = fs.existsSync(path.join(runDir, "FINISHED"));

    // Incremental: new iter PNGs + FINISHED.
    this.activeRunWatcher = fs.watch(runDir, { persistent: false }, (_e, filename) => {
      if (!filename) return;
      const fp = path.join(runDir, filename);
      if (!fs.existsSync(fp)) return;
      const m = ITER_PNG_RE.exec(filename);
      if (m) { this.sink?.image(fp, parseInt(m[1], 10)); return; }
      if (filename === "FINISHED" && !this.finishedSeen) { this.finishedSeen = true; this.onFinished(runDir); }
    });

    // Incremental: appended AMICODE_ITER lines.
    this.logTailer = new LogTailer({
      path: path.join(runDir, "run.log"),
      channel: this.opts.channel,
      onLine: (line) => {
        const m = AMICODE_ITER_RE.exec(line);
        if (m) this.sink?.iter({ iter: +m[1], f_val: +m[2], inf_pr: +m[3], inf_du: +m[4] });
      },
    });
    this.logTailer.start();
  }

  private onFinished(runDir: string): void {
    const finished = readTomlSafe(path.join(runDir, "FINISHED"));
    if (!finished || !validateFinished(finished).ok) return;
    const status = finished.status as RunStatus;
    const runId = String(readTomlSafe(path.join(runDir, "manifest.toml"))?.run_id ?? path.basename(runDir));
    let fidelity: number | undefined;
    if (status === "completed") {
      const result = readTomlSafe(path.join(runDir, "result.toml"));
      if (result && validateResult(result).ok) fidelity = result.fidelity as number;
    }
    this.sink?.run({ runId, runDir, status, fidelity });
    if (status === "completed" && fidelity !== undefined && fidelity >= (this.opts.promoteThreshold ?? 0.99)) {
      this.sink?.promote({ runId, runDir, fidelity });
    }
  }
}

// ===========================================================================
// LogTailer — follows run.log as julia appends, emitting each new line.
// ===========================================================================

interface LogTailerOptions { path: string; channel: vscode.OutputChannel; onLine: (line: string) => void }

class LogTailer implements vscode.Disposable {
  private watcher?: fs.FSWatcher;
  private offset = 0;
  private buf = "";
  private pollTimer?: NodeJS.Timeout;
  private disposed = false;

  constructor(private readonly opts: LogTailerOptions) {}

  start(): void {
    const tryAttach = () => {
      if (this.disposed) return;
      if (fs.existsSync(this.opts.path)) this.attach();
      else this.pollTimer = setTimeout(tryAttach, 250);
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
    // Skip the body already replayed by ingestRunDir; tail only appended lines.
    try { this.offset = fs.statSync(this.opts.path).size; } catch { this.offset = 0; }
    try {
      this.watcher = fs.watch(this.opts.path, { persistent: false }, (event) => {
        if (event === "change") this.drain();
      });
    } catch (err) {
      this.opts.channel.appendLine(`[runs] log tail attach failed: ${(err as Error).message}`);
    }
  }

  private drain(): void {
    if (this.disposed) return;
    let fd: number;
    try { fd = fs.openSync(this.opts.path, "r"); } catch { return; }
    try {
      const size = fs.fstatSync(fd).size;
      if (size < this.offset) { this.offset = 0; this.buf = ""; }
      if (size === this.offset) return;
      const chunk = Buffer.allocUnsafe(size - this.offset);
      const read = fs.readSync(fd, chunk, 0, chunk.length, this.offset);
      this.offset += read;
      this.buf += chunk.subarray(0, read).toString("utf8");
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        try { this.opts.onLine(line); } catch (e) { this.opts.channel.appendLine(`[runs] onLine threw: ${String(e)}`); }
      }
    } finally {
      try { fs.closeSync(fd); } catch { /* noop */ }
    }
  }
}
