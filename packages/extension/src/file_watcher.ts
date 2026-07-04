import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { validateFinished, validateResult } from "@amicode/amico-run";
import { getInspector } from "./run_inspector";
import type { StatusBarManager } from "./status_bar";
import type { RunStatus } from "./types";
import {
  AMICODE_ITER_RE, detectStopped, ingestRunDir, readTomlSafe, parseAmicoNum, promoteEligibility, PulseStream, SinkDedup,
  type IterRecord, type PulseEvent, type RunCompletion, type PromoteInfo, type RunSink,
} from "./run_dir_reader";

// ============================================================================
// RunsRootWatcher — watches the β.1 run-dir contract and drives the Inspector
// + status bar. Follows the `latest` symlink; for the active run it reads:
//   run.toml  → run identity (run_id, lab_id), written FIRST
//   run.log        → AMICODE_ITER lines → live stats row · AMICODE_PULSE
//                    lines → native live pulse plot (#66; iter_<N>.png stays a
//                    run-dir/archival artifact but is no longer displayed)
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
  /** Newest-wins guard: frame display vs log-line iters tracked separately so the
   *  log high-water mark can't suppress lagging frames (see SinkDedup). */
  private readonly dedup = new SinkDedup();
  /** Live pulse-line gate (#66). Re-armed by replayed meta events so tailed
   *  records after a mid-flight switch keep their governing shape. */
  private readonly pulses = new PulseStream();
  constructor(
    private readonly opts: RunsRootWatcherOptions,
    private readonly runId: string,
    private readonly runDir: string,
    /** Shared across run-switches so a run promotes at most once (no re-pop). */
    private readonly promotedRuns: Set<string>,
  ) {}

  iter(rec: IterRecord): void {
    this.dedup.noteIter(rec.iter);
    getInspector()?.postIterationRecord(rec);
    // Live status-bar update — show "running · iter N" as it solves, not only at
    // completion (#5 AC3).
    this.opts.statusBar?.setRun({
      runId: this.runId, outputDir: this.runDir, startedAt: 0,
      status: "running", latestIter: rec.iter,
    });
  }
  run(c: RunCompletion): void {
    // Tell the inspector the run is terminal so the badge leaves "running".
    // Fires on live finish (onFinished) AND replay of an already-finished run
    // (ingestRunDir) — both route through this sink.
    getInspector()?.postCompletion(c.status, c.fidelity);
    this.opts.statusBar?.setRun({
      runId: c.runId, outputDir: c.runDir, startedAt: 0,
      status: c.status, latestIter: this.dedup.high >= 0 ? this.dedup.high : undefined,
      fidelity: c.fidelity,
    });
    this.opts.channel.appendLine(`[runs] ${c.runId} ${c.status}${c.fidelity !== undefined ? ` F=${c.fidelity.toFixed(6)}` : ""}`);
    if (c.status !== "completed") {
      this.opts.channel.appendLine(`[runs] see ${path.join(c.runDir, "run.log")}`);
    }
  }
  pulse(e: PulseEvent): void {
    if (e.type === "meta") this.pulses.arm(e.meta);
    getInspector()?.postPulse(e);
  }
  /** Tail path (#66 AC6): feed a raw run.log line through the pulse gate and
   *  forward any accepted event. On a live run this is the ONLY meta carrier —
   *  ingest ran against an empty log. */
  pulseLine(line: string): void {
    const e = this.pulses.onLine(line);
    if (e) this.pulse(e);
  }
  promote(info: PromoteInfo): void {
    if (this.promotedRuns.has(info.runId)) return;
    this.promotedRuns.add(info.runId);
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
  /** Runs already promoted (or already-finished when first switched to) — so the
   *  promote prompt fires at most once per run, never re-popping on re-switch /
   *  launch-follows-latest. */
  private readonly promotedRuns = new Set<string>();
  /** Polling backstop. macOS fs.watch (FSEvents) coalesces and silently drops
   *  events — especially under load — so the symlink-follow + run-dir watches
   *  can miss `latest` swings and FINISHED, and the log tailer's change events
   *  can go quiet. The periodic tick re-resolves `latest`, re-checks FINISHED,
   *  and pokes the tailer (which self-attaches if run.log appeared unseen); the
   *  fs.watch paths stay for low latency. All sinks are idempotent
   *  (finishedSeen, log byte-offset), so double-delivery is harmless. */
  private poll?: NodeJS.Timeout;
  private static readonly POLL_MS = 700;

  constructor(private readonly opts: RunsRootWatcherOptions) {}

  start(): void {
    fs.mkdirSync(this.opts.runsRoot, { recursive: true });
    const latest = path.join(this.opts.runsRoot, "latest");
    if (fs.existsSync(latest)) {
      // On launch, stay IDLE for a previous, already-finished run — don't re-display
      // its last plot. Only resume a still-running run. A run that starts AFTER
      // launch is picked up normally (idle → warming → frames). To baseline a
      // finished run we set activeRunDir WITHOUT a sink, so the poll won't render it.
      try {
        const target = fs.realpathSync(latest);
        if (fs.existsSync(path.join(target, "FINISHED"))) { this.activeRunDir = target; this.finishedSeen = true; }
        else this.followLatest();
      } catch { /* noop */ }
    }
    this.rootWatcher = fs.watch(this.opts.runsRoot, { persistent: false }, (_e, filename) => {
      if (filename === "latest") this.followLatest();
    });
    this.poll = setInterval(() => this.tick(), RunsRootWatcher.POLL_MS);
    this.opts.channel.appendLine(`[runs] watching ${this.opts.runsRoot} (fs.watch + ${RunsRootWatcher.POLL_MS}ms poll)`);
  }

  /** fs.watch backstop: re-resolve `latest`, then rescan the active run for new
   *  frames / FINISHED and drain the log — catching anything FSEvents dropped. */
  private tick(): void {
    try {
      if (fs.existsSync(path.join(this.opts.runsRoot, "latest"))) this.followLatest();
      const runDir = this.activeRunDir;
      if (!runDir || !this.sink) return;
      if (!this.finishedSeen && fs.existsSync(path.join(runDir, "FINISHED"))) {
        this.finishedSeen = true; this.onFinished(runDir);
      }
      this.logTailer?.poke();                                          // drain appended AMICODE_ITER lines
    } catch { /* transient fs race — next tick retries */ }
  }

  dispose(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
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

    const runId = String(readTomlSafe(path.join(runDir, "run.toml"))?.run_id ?? path.basename(runDir));
    // If the run was ALREADY finished when we switched to it (e.g. launch follows
    // `latest` to a prior completed run, or the user switches back), don't pop the
    // promote prompt — only a FRESH live completion promotes. Pre-marking the run
    // suppresses the replay-driven promote below.
    const finishedAtSwitch = fs.existsSync(path.join(runDir, "FINISHED"));
    if (finishedAtSwitch) this.promotedRuns.add(runId);

    this.sink = new LiveRunSink(this.opts, runId, runDir, this.promotedRuns);
    getInspector()?.reveal();
    getInspector()?.setRunLabel(runId);

    // Replay everything already on disk (late-join safe). Returns the run.log
    // bytes consumed so the tailer attaches exactly there (no skipped iters).
    let logBytes = 0;
    try { logBytes = ingestRunDir(runDir, this.sink, this.opts.promoteThreshold ?? 0.99); }
    catch (err) { this.opts.channel.appendLine(`[runs] replay failed: ${(err as Error).message}`); }
    this.finishedSeen = finishedAtSwitch;

    // Fresh unfinished run → Julia warming up; show that instead of an idle
    // panel so the ~minute cold start isn't read as frozen. The view swaps the
    // hint for the plot when the first pulse record arrives.
    if (!finishedAtSwitch) getInspector()?.setWarmingUp();

    // Incremental: FINISHED (pulse/iter lines arrive via the log tailer).
    // Also watch verification.toml: a free-tier run's FINISHED lands BEFORE
    // amico-run's harness writes verification.toml, so onFinished may see the
    // promote as "pending" — re-run the promote check when verification lands
    // (spec C: late verification still promotes exactly once).
    this.activeRunWatcher = fs.watch(runDir, { persistent: false }, (_e, filename) => {
      if (!filename) return;
      if (!fs.existsSync(path.join(runDir, filename))) return;
      if (filename === "FINISHED" && !this.finishedSeen) { this.finishedSeen = true; this.onFinished(runDir); }
      if (filename === "verification.toml") this.onFinished(runDir);
    });

    // Incremental: appended AMICODE_ITER lines — start at the ingest offset so a
    // line written between the replay read and this attach isn't skipped.
    this.logTailer = new LogTailer({
      path: path.join(runDir, "run.log"),
      startOffset: logBytes,
      channel: this.opts.channel,
      onLine: (line) => {
        const m = AMICODE_ITER_RE.exec(line);
        if (m) { this.sink?.iter({ iter: +m[1], f_val: parseAmicoNum(m[2]), inf_pr: parseAmicoNum(m[3]), inf_du: parseAmicoNum(m[4]) }); return; }
        this.sink?.pulseLine(line);
      },
    });
    this.logTailer.start();
  }

  private onFinished(runDir: string): void {
    const finished = readTomlSafe(path.join(runDir, "FINISHED"));
    if (!finished || !validateFinished(finished).ok) return;
    const rawStatus = finished.status as RunStatus;
    // Relabel a cooperative user-stop (exits 0 → "completed") to "stopped" on the
    // LIVE path too — onFinished never routes through ingestRunDir. Before the
    // promote gate below (promote requires "completed").
    const status: RunStatus = rawStatus === "completed" && detectStopped(runDir) ? "stopped" : rawStatus;
    const runId = String(readTomlSafe(path.join(runDir, "run.toml"))?.run_id ?? path.basename(runDir));
    let fidelity: number | undefined;
    if (status === "completed") {
      const result = readTomlSafe(path.join(runDir, "result.toml"));
      if (result) {
        const v = validateResult(result);
        if (v.ok) fidelity = result.fidelity as number;
        // Don't silently drop fidelity + skip promote on a present-but-invalid
        // result.toml — say why (S4). e.g. a pre-0.1a result.toml with no
        // schema_version, or a fidelity gross-out-of-range.
        else this.opts.channel.appendLine(`[runs] result.toml present but invalid: ${v.errors.join("; ")}`);
      }
    }
    this.sink?.run({ runId, runDir, status, fidelity });
    if (status === "completed" && fidelity !== undefined && fidelity >= (this.opts.promoteThreshold ?? 0.99)) {
      // spec C: gate promotion on free-tier verification. "pending" → don't
      // promote AND don't mark promoted — the verification.toml watch re-runs
      // this and promotes once it lands (promote() itself dedups via promotedRuns).
      const eligibility = promoteEligibility(runDir);
      if (eligibility === "eligible") this.sink?.promote({ runId, runDir, fidelity });
      else this.opts.channel.appendLine(`[runs] promote gated for ${runId}: free-tier verification ${eligibility}`);
    }
  }
}

// ===========================================================================
// LogTailer — follows run.log as julia appends, emitting each new line.
// ===========================================================================

interface LogTailerOptions { path: string; channel: vscode.OutputChannel; onLine: (line: string) => void; startOffset?: number }

class LogTailer implements vscode.Disposable {
  private watcher?: fs.FSWatcher;
  private offset = 0;
  private buf = "";
  private pollTimer?: NodeJS.Timeout;
  private disposed = false;
  private attached = false;

  constructor(private readonly opts: LogTailerOptions) {}

  /** Backstop drain (called by the watcher's poll). Attaches first if run.log
   *  has appeared since start() (the 250ms retry timer may not have fired yet —
   *  same coalesced-FSEvents rationale as the poll itself). attach() sets the
   *  start offset, so it never re-reads lines ingestRunDir already replayed. */
  poke(): void {
    if (this.disposed) return;
    if (!this.attached && fs.existsSync(this.opts.path)) this.attach();
    if (this.attached) this.drain();
  }

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
    if (this.disposed || this.attached) return;
    // Start where ingestRunDir stopped reading (startOffset), not at current EOF —
    // otherwise lines appended between the replay read and this attach are lost.
    this.offset = this.opts.startOffset ?? 0;
    this.attached = true;
    try {
      this.watcher = fs.watch(this.opts.path, { persistent: false }, (event) => {
        if (event === "change") this.drain();
      });
    } catch (err) {
      this.opts.channel.appendLine(`[runs] log tail attach failed: ${(err as Error).message}`);
    }
    // Drain immediately to catch lines already written past startOffset.
    this.drain();
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
