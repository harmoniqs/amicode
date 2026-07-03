import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { validateFinished, validateResult } from "@amicode/amico-run";
import { getInspector } from "./run_inspector";
import { LogTailer } from "./log_tailer";
import { parseIndexLine, RunRegistry, type RunRecord } from "./run_registry";
import type { StatusBarManager } from "./status_bar";
import type { RunStatus } from "./types";
import {
  AMICODE_ITER_RE, ingestRunDir, readTomlSafe, parseAmicoNum, PulseStream, SinkDedup,
  type IterRecord, type PulseEvent, type RunCompletion, type PromoteInfo, type RunSink,
} from "./run_dir_reader";

// ============================================================================
// RunsManager (1.2, #57) — the multi-run evolution of β's RunsRootWatcher.
//
// Discovery: tails the APPEND-ONLY `runs/index` (amico-run appends one TSV line
// per run) instead of following the `latest` symlink — `latest` keeps being
// written (frozen contract) but is display-era plumbing; the index is the
// multi-run source of truth. Every line registers a run; every run WITHOUT a
// FINISHED gets its own live pipeline (replay → run-dir watch → run.log tail),
// so N concurrent solves are ALL tracked to completion — a second solve no
// longer yanks tracking off the first mid-flight.
//
// Fan-out: per-run events land in the registry (state) and are ROUTED to the
// single-run Inspector/StatusBar only for the SELECTED run (1.3 fans the
// inspector itself into per-run views; `selectRun` is its seam). Completions
// and the promote prompt fire for EVERY run, selected or not. Selection
// auto-follows the newest started run (parity with β's latest-follow UX).
//
// Completion keys on FINISHED (never result.toml presence); the contract
// reading is the pure `ingestRunDir`. Double-delivery between a selection
// replay and a live tail is tolerated by design — every consumer is
// idempotent/newest-wins (same rationale as the poll backstop).
//
// Scheduler (1.1, #56/#68): `attachScheduler` consumes the lifecycle stream —
// a `started` event registers + selects the run immediately (faster than the
// index tail; also the only path for runs under a non-default runsRoot).
// Structural type so this compiles independently of the Scheduler landing.
// ============================================================================

export interface RunsManagerOptions {
  runsRoot: string;
  channel: vscode.OutputChannel;
  statusBar?: StatusBarManager;
  promoteThreshold?: number;
}

/** The #56 Scheduler's lifecycle surface (structural — see amico-run scheduler.ts). */
export interface SchedulerLifecycleEvent {
  kind: "queued" | "started" | "finished" | "cancelled" | "error";
  queueId: string;
  runId?: string;
  runDir?: string;
  position?: number;
  status?: string;
  exitCode?: number;
  message?: string;
}
export interface SchedulerLike {
  onEvent(listener: (e: SchedulerLifecycleEvent) => void): () => void;
}

/** One live run's incremental machinery. State-only: routing decisions live in
 *  the manager (selection may change while this pipeline runs). */
class RunPipeline implements vscode.Disposable {
  readonly pulses = new PulseStream();
  readonly dedup = new SinkDedup();
  finishedSeen = false;
  dirWatcher?: fs.FSWatcher;
  tailer?: LogTailer;

  constructor(readonly runId: string, readonly runDir: string) {}

  dispose(): void {
    try { this.dirWatcher?.close(); } catch { /* noop */ }
    this.tailer?.dispose();
    this.dirWatcher = undefined;
    this.tailer = undefined;
  }
}

export class RunsManager implements vscode.Disposable {
  private readonly registry = new RunRegistry();
  private readonly pipelines = new Map<string, RunPipeline>();
  private indexTailer?: LogTailer;
  private rootWatcher?: fs.FSWatcher;
  private poll?: NodeJS.Timeout;
  private selected?: string;
  private schedulerDispose?: () => void;
  /** Promote-once + never-on-replay: runs finished at DISCOVERY are pre-marked
   *  so only a fresh live completion prompts (ports β's finishedAtSwitch). */
  private readonly promotedRuns = new Set<string>();
  private static readonly POLL_MS = 700;

  constructor(private readonly opts: RunsManagerOptions) {}

  start(): void {
    fs.mkdirSync(this.opts.runsRoot, { recursive: true });
    // Discovery = tail the append-only index from offset 0. Launch replays the
    // whole history: finished runs register terminal (idle — nothing rendered);
    // a run still live across a window reload gets a pipeline and, being the
    // newest live line, wins auto-selection (resume, β parity).
    this.indexTailer = new LogTailer({
      path: path.join(this.opts.runsRoot, "index"),
      startOffset: 0,
      channel: this.opts.channel,
      onLine: (line) => {
        const e = parseIndexLine(line);
        if (e) this.registerRun(e.runId, path.join(this.opts.runsRoot, e.runId), e.createdAt, e.scriptPath);
      },
    });
    this.indexTailer.start();
    this.rootWatcher = fs.watch(this.opts.runsRoot, { persistent: false }, (_e, filename) => {
      if (filename === "index") this.indexTailer?.poke();
    });
    this.poll = setInterval(() => this.tick(), RunsManager.POLL_MS);
    this.opts.channel.appendLine(`[runs] watching ${this.opts.runsRoot}/index (fs.watch + ${RunsManager.POLL_MS}ms poll)`);
  }

  /** Poll backstop — macOS FSEvents coalesces/drops events, so re-poke the
   *  index tail and every live pipeline (FINISHED re-check + log drain). All
   *  consumers are idempotent, so double-delivery is harmless. */
  private tick(): void {
    try {
      this.indexTailer?.poke();
      for (const p of this.pipelines.values()) {
        this.checkFinished(p);
        p.tailer?.poke();
      }
    } catch { /* transient fs race — next tick retries */ }
  }

  dispose(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
    try { this.rootWatcher?.close(); } catch { /* noop */ }
    this.rootWatcher = undefined;
    this.indexTailer?.dispose();
    this.indexTailer = undefined;
    this.schedulerDispose?.();
    this.schedulerDispose = undefined;
    for (const p of this.pipelines.values()) p.dispose();
    this.pipelines.clear();
  }

  /** Consume the #56 Scheduler lifecycle: `started` registers + selects the run
   *  immediately (its runDir is authoritative — may live outside runsRoot). */
  attachScheduler(scheduler: SchedulerLike): void {
    this.schedulerDispose?.();
    this.schedulerDispose = scheduler.onEvent((e) => {
      if (e.kind === "started" && e.runId && e.runDir) {
        this.registerRun(e.runId, e.runDir);
        return;
      }
      this.opts.channel.appendLine(`[runs] scheduler ${e.kind} ${e.runId ?? e.queueId}${e.message ? `: ${e.message}` : ""}`);
    });
  }

  /** Route the single-run Inspector/StatusBar at a run (1.3's seam; also called
   *  by auto-follow). Replays the run dir for display, then live events flow. */
  selectRun(runId: string): void {
    const rec = this.registry.get(runId);
    if (!rec || this.selected === runId) return;
    this.selected = runId;
    getInspector()?.reveal();
    getInspector()?.setRunLabel(runId);
    // Display replay (late-join safe): full history from disk → inspector.
    // Promote inside the replay stays guarded by promotedRuns, so re-selecting
    // a finished run never re-pops the prompt.
    try { ingestRunDir(rec.runDir, this.displaySink(rec), this.opts.promoteThreshold ?? 0.99); }
    catch (err) { this.opts.channel.appendLine(`[runs] replay failed: ${(err as Error).message}`); }
    // Fresh/live run → Julia warming up (the view swaps the hint when the first
    // pulse record arrives). Same post-replay order as β's switchToRun.
    if (rec.phase !== "finished") getInspector()?.setWarmingUp();
  }

  /** Force immediate index-tail drain — for flows that just appended an index
   *  line (demo replay) and want same-tick registration instead of waiting on
   *  fs.watch/poll. */
  pokeDiscovery(): void {
    this.indexTailer?.poke();
  }

  /** Registry snapshot (1.3 trees / tests). */
  runs(): RunRecord[] {
    return this.registry.all();
  }

  get selectedRun(): string | undefined {
    return this.selected;
  }

  // -------- internal --------

  private registerRun(runId: string, runDir: string, createdAt?: string, scriptPath?: string): void {
    if (this.registry.get(runId)) return;   // idempotent — the index replays from 0 every launch
    if (!fs.existsSync(runDir)) {
      this.opts.channel.appendLine(`[runs] index names ${runId} but ${runDir} is missing — skipped`);
      return;
    }
    const finishedAtDiscovery = fs.existsSync(path.join(runDir, "FINISHED"));
    if (finishedAtDiscovery) {
      // Terminal at discovery: record it (status/fidelity for the registry) but
      // render nothing and never re-pop the promote prompt (β launch parity).
      const t = this.readTerminal(runDir);
      this.registry.register({ runId, runDir, createdAt, scriptPath, phase: "finished", status: t?.status, fidelity: t?.fidelity });
      this.promotedRuns.add(runId);
      return;
    }
    this.registry.register({ runId, runDir, createdAt, scriptPath, phase: "live" });
    const p = new RunPipeline(runId, runDir);
    this.pipelines.set(runId, p);

    // State replay: arms the pipeline's pulse stream (meta), seeds iter
    // high-water, and yields the byte offset the live tail starts from. Routes
    // to the inspector only if this run is (still) selected — at registration
    // it never is; the display replay below covers it.
    let logBytes = 0;
    try { logBytes = ingestRunDir(runDir, this.pipelineSink(p), this.opts.promoteThreshold ?? 0.99); }
    catch (err) { this.opts.channel.appendLine(`[runs] replay failed: ${(err as Error).message}`); }

    // FINISHED landed between the existsSync check and the replay (rare race):
    // completeRun already tore the pipeline down — don't attach watch/tail to a
    // disposed pipeline; just show the (live) completion.
    if (this.registry.get(runId)?.phase === "finished") {
      this.selectRun(runId);
      return;
    }

    // Incremental: FINISHED (authoritative terminal), then appended log lines.
    p.dirWatcher = fs.watch(runDir, { persistent: false }, (_e, filename) => {
      if (filename === "FINISHED") this.checkFinished(p);
    });
    p.tailer = new LogTailer({
      path: path.join(runDir, "run.log"),
      startOffset: logBytes,
      channel: this.opts.channel,
      onLine: (line) => {
        const m = AMICODE_ITER_RE.exec(line);
        if (m) { this.routeIter(p, { iter: +m[1], f_val: parseAmicoNum(m[2]), inf_pr: parseAmicoNum(m[3]), inf_du: parseAmicoNum(m[4]) }); return; }
        const e = p.pulses.onLine(line);
        if (e) this.routePulse(p.runId, e);
      },
    });
    p.tailer.start();

    // Auto-follow: a newly REGISTERED live run is by definition the newest
    // start (index lines append in creation order) — β latest-follow parity.
    this.selectRun(runId);
  }

  /** State-only sink for a pipeline's initial replay. */
  private pipelineSink(p: RunPipeline): RunSink {
    return {
      iter: (rec: IterRecord) => this.routeIter(p, rec),
      // A FINISHED that landed between the existsSync check and this replay —
      // rare race; treat exactly like a live completion.
      run: (c: RunCompletion) => this.completeRun(p.runId, c.status, c.fidelity),
      pulse: (e: PulseEvent) => {
        if (e.type === "meta") p.pulses.arm(e.meta);
        this.routePulse(p.runId, e);
      },
      promote: (info: PromoteInfo) => this.promptPromote(info),
    };
  }

  /** Display sink for selection replays: inspector + status bar; promote stays
   *  guarded. For a still-live run, meta also re-arms the pipeline stream. */
  private displaySink(rec: RunRecord): RunSink {
    const p = this.pipelines.get(rec.runId);
    return {
      iter: (r: IterRecord) => {
        this.registry.noteIter(rec.runId, r.iter);
        getInspector()?.postIterationRecord(r);
        this.opts.statusBar?.setRun({ runId: rec.runId, outputDir: rec.runDir, startedAt: 0, status: "running", latestIter: r.iter });
      },
      run: (c: RunCompletion) => {
        getInspector()?.postCompletion(c.status, c.fidelity);
        this.opts.statusBar?.setRun({ runId: c.runId, outputDir: c.runDir, startedAt: 0, status: c.status, latestIter: this.registry.get(rec.runId)?.latestIter, fidelity: c.fidelity });
      },
      pulse: (e: PulseEvent) => {
        if (e.type === "meta") p?.pulses.arm(e.meta);
        getInspector()?.postPulse(e);
      },
      promote: (info: PromoteInfo) => this.promptPromote(info),
    };
  }

  private routeIter(p: RunPipeline, rec: IterRecord): void {
    p.dedup.noteIter(rec.iter);
    this.registry.noteIter(p.runId, rec.iter);
    if (this.selected !== p.runId) return;
    getInspector()?.postIterationRecord(rec);
    // Live status-bar update — "running · iter N" as it solves (#5 AC3).
    this.opts.statusBar?.setRun({ runId: p.runId, outputDir: p.runDir, startedAt: 0, status: "running", latestIter: rec.iter });
  }

  private routePulse(runId: string, e: PulseEvent): void {
    if (this.selected !== runId) return;
    getInspector()?.postPulse(e);
  }

  private checkFinished(p: RunPipeline): void {
    if (p.finishedSeen) return;
    if (!fs.existsSync(path.join(p.runDir, "FINISHED"))) return;
    const t = this.readTerminal(p.runDir);
    if (!t) return;   // torn/invalid FINISHED — next tick retries
    p.finishedSeen = true;
    this.completeRun(p.runId, t.status, t.fidelity);
  }

  /** Terminal handling for ANY run, selected or not: registry, teardown,
   *  channel, inspector/status-bar (selected only), promote (any run, once). */
  private completeRun(runId: string, status: RunStatus, fidelity?: number): void {
    const rec = this.registry.get(runId);
    if (!rec || rec.phase === "finished") return;   // idempotent (watch + poll can both fire)
    this.registry.markFinished(runId, status, fidelity);
    const p = this.pipelines.get(runId);
    p?.dispose();
    this.pipelines.delete(runId);
    this.opts.channel.appendLine(`[runs] ${runId} ${status}${fidelity !== undefined ? ` F=${fidelity.toFixed(6)}` : ""}`);
    if (status !== "completed") this.opts.channel.appendLine(`[runs] see ${path.join(rec.runDir, "run.log")}`);
    if (this.selected === runId) {
      getInspector()?.postCompletion(status, fidelity);
      this.opts.statusBar?.setRun({ runId, outputDir: rec.runDir, startedAt: 0, status, latestIter: rec.latestIter, fidelity });
    }
    if (status === "completed" && fidelity !== undefined && fidelity >= (this.opts.promoteThreshold ?? 0.99)) {
      this.promptPromote({ runId, runDir: rec.runDir, fidelity });
    }
  }

  /** FINISHED (+ result.toml fidelity) with the same validation + say-why
   *  logging as β (S4: a present-but-invalid result.toml is named, not
   *  silently dropped). */
  private readTerminal(runDir: string): { status: RunStatus; fidelity?: number } | undefined {
    const finished = readTomlSafe(path.join(runDir, "FINISHED"));
    if (!finished || !validateFinished(finished).ok) return undefined;
    const status = finished.status as RunStatus;
    let fidelity: number | undefined;
    if (status === "completed") {
      const result = readTomlSafe(path.join(runDir, "result.toml"));
      if (result) {
        const v = validateResult(result);
        if (v.ok) fidelity = result.fidelity as number;
        else this.opts.channel.appendLine(`[runs] result.toml present but invalid: ${v.errors.join("; ")}`);
      }
    }
    return { status, fidelity };
  }

  private promptPromote(info: PromoteInfo): void {
    if (this.promotedRuns.has(info.runId)) return;
    this.promotedRuns.add(info.runId);
    void (async () => {
      const choice = await vscode.window.showInformationMessage(
        `Amicode: solve converged (F=${info.fidelity.toFixed(4)}). Promote pulse to catalog?`,
        "Yes — promote", "No — keep local only",
      );
      if (choice === "Yes — promote") {
        // #47: record in the session catalog + open the card (store persistence
        // is still Phase 3 — the session catalog is workspaceState). Ported from
        // file_watcher.ts (Kate's #73), which this manager supersedes.
        await vscode.commands.executeCommand("amicode.catalog.save", info.runDir).then(undefined, () => undefined);
      }
    })();
  }
}
