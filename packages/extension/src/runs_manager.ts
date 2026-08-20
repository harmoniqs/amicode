import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  postRunIteration,
  postRunPulse,
  postRunPulseMeta,
  postRunCompletion,
  postRunActivate,
  postRunLabel,
  postRunTiming,
} from "./inspector_bridge";
import { LogTailer } from "./log_tailer";
import { parseIndexLine, RunRegistry, type RunRecord } from "./run_registry";
import { parseMaxIter } from "./run_timing";
import type { RunStatus } from "./types";
import {
  AMICODE_ITER_RE,
  ingestRunDir,
  readTerminalState,
  readTomlSafe,
  parseAmicoNum,
  PulseStream,
  SinkDedup,
  type IterRecord,
  type PulseEvent,
  type RunCompletion,
  type PromoteInfo,
  type RunSink,
} from "./run_dir_reader";


export interface RunsManagerOptions {
  runsRoot: string;
  channel: vscode.OutputChannel;
  promoteThreshold?: number;
  onRunFinished?: (info: { runId: string; runDir: string; status: string }) => void;
}

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

class RunPipeline implements vscode.Disposable {
  readonly pulses = new PulseStream();
  readonly dedup = new SinkDedup();
  finishedSeen = false;
  dirWatcher?: fs.FSWatcher;
  tailer?: LogTailer;

  constructor(
    readonly runId: string,
    readonly runDir: string,
  ) {}

  dispose(): void {
    try {
      this.dirWatcher?.close();
    } catch {
      /* noop */
    }
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
  private pinned = false;
  private schedulerDispose?: () => void;
  private readonly promotedRuns = new Set<string>();
  private static readonly POLL_MS = 700;

  constructor(private readonly opts: RunsManagerOptions) {}

  start(): void {
    fs.mkdirSync(this.opts.runsRoot, { recursive: true });
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
    this.rootWatcher.on("error", (e) => this.opts.channel.appendLine(`[runs] root watch error: ${String(e)}`));
    this.poll = setInterval(() => this.tick(), RunsManager.POLL_MS);
    this.opts.channel.appendLine(
      `[runs] watching ${this.opts.runsRoot}/index (fs.watch + ${RunsManager.POLL_MS}ms poll)`,
    );
  }

  private tick(): void {
    try {
      this.indexTailer?.poke();
      for (const p of this.pipelines.values()) {
        this.checkFinished(p);
        p.tailer?.poke();
      }
    } catch {
      /* transient fs race — next tick retries */
    }
  }

  dispose(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
    try {
      this.rootWatcher?.close();
    } catch {
      /* noop */
    }
    this.rootWatcher = undefined;
    this.indexTailer?.dispose();
    this.indexTailer = undefined;
    this.schedulerDispose?.();
    this.schedulerDispose = undefined;
    for (const p of this.pipelines.values()) p.dispose();
    this.pipelines.clear();
  }

  attachScheduler(scheduler: SchedulerLike): void {
    this.schedulerDispose?.();
    this.schedulerDispose = scheduler.onEvent((e) => {
      if (e.kind === "started" && e.runId && e.runDir) {
        this.registerRun(e.runId, e.runDir);
        return;
      }
      this.opts.channel.appendLine(
        `[runs] scheduler ${e.kind} ${e.runId ?? e.queueId}${e.message ? `: ${e.message}` : ""}`,
      );
    });
  }

  selectRun(runId: string): void {
    const rec = this.registry.get(runId);
    if (!rec) return;
    this.pinned = true;
    if (this.selected === runId) return;
    this.selected = runId;
    postRunLabel(runId, runId);
    postRunActivate(runId);
    const p = this.pipelines.get(runId);
    if (p) {
      this.checkFinished(p);
    } else {
      try {
        ingestRunDir(rec.runDir, this.displaySink(rec), this.opts.promoteThreshold ?? 0.99);
      } catch (err) {
        this.opts.channel.appendLine(`[runs] replay failed: ${(err as Error).message}`);
      }
    }
    // warming previously handled via inspector.setWarmingUp — now no-op;
    // the Work Column tab shows idle until the first iteration arrives.
  }

  pokeDiscovery(): void {
    this.indexTailer?.poke();
  }

  runs(): RunRecord[] {
    return this.registry.all();
  }

  get selectedRun(): string | undefined {
    return this.selected;
  }

  getActiveRunDir(): string | undefined {
    return this.selected ? this.registry.get(this.selected)?.runDir : undefined;
  }

  getActiveRunPointer(): string | undefined {
    return this.selected ? this.registry.get(this.selected)?.runId : undefined;
  }

  resumeAutoFollow(): void {
    this.pinned = false;
    const live = this.registry.all().filter((r) => r.phase === "live");
    const newest = live[live.length - 1];
    if (newest && this.selected !== newest.runId) {
      this.selectRun(newest.runId);
      this.pinned = false;
    }
  }

  // -------- internal --------

  private registerRun(runId: string, runDir: string, createdAt?: string, scriptPath?: string): void {
    if (this.registry.get(runId)) {
      this.registry.backfill(runId, { createdAt, scriptPath });
      return;
    }
    if (!fs.existsSync(runDir)) {
      this.opts.channel.appendLine(`[runs] index names ${runId} but ${runDir} is missing — skipped`);
      return;
    }
    const finishedAtDiscovery = fs.existsSync(path.join(runDir, "FINISHED"));
    if (finishedAtDiscovery) {
      const t = this.readTerminal(runDir);
      if (t) {
        this.registry.register({
          runId,
          runDir,
          createdAt,
          scriptPath,
          phase: "finished",
          status: t.status,
          fidelity: t.fidelity,
        });
        this.promotedRuns.add(runId);
        return;
      }
      this.promotedRuns.add(runId);
    }
    this.registry.register({ runId, runDir, createdAt, scriptPath, phase: "live" });
    const p = new RunPipeline(runId, runDir);

    this.pipelines.set(runId, p);

    // Timing: post elapsed base via bridge (Work Column renders elapsed)
    {
      const manifest = readTomlSafe(path.join(runDir, "run.toml"));
      const createdAtMs = manifest?.created_at ? Date.parse(String(manifest.created_at)) : NaN;
      let maxIter: number | undefined;
      try {
        if (manifest?.script_path) maxIter = parseMaxIter(fs.readFileSync(String(manifest.script_path), "utf8"));
      } catch {
        /* script gone */
      }
      if (Number.isFinite(createdAtMs)) {
        const elapsed = (Date.now() - createdAtMs) / 1000;
        postRunTiming(runId, elapsed);
      }
      void maxIter;
    }

    const follow = !this.pinned;
    if (follow && this.selected !== runId) {
      this.selected = runId;
      postRunLabel(runId, runId);
      postRunActivate(runId);
    }

    let logBytes = 0;
    try {
      logBytes = ingestRunDir(runDir, this.pipelineSink(p), this.opts.promoteThreshold ?? 0.99);
    } catch (err) {
      this.opts.channel.appendLine(`[runs] replay failed: ${(err as Error).message}`);
    }

    if (this.registry.get(runId)?.phase === "finished") return;

    p.dirWatcher = fs.watch(runDir, { persistent: false }, (_e, filename) => {
      if (filename === "FINISHED") this.checkFinished(p);
    });
    p.dirWatcher.on("error", (e) => this.opts.channel.appendLine(`[runs] ${runId} dir watch error: ${String(e)}`));
    p.tailer = new LogTailer({
      path: path.join(runDir, "run.log"),
      startOffset: logBytes,
      channel: this.opts.channel,
      onLine: (line) => {
        const m = AMICODE_ITER_RE.exec(line);
        if (m) {
          this.routeIter(p, {
            iter: +m[1],
            f_val: parseAmicoNum(m[2]),
            inf_pr: parseAmicoNum(m[3]),
            inf_du: parseAmicoNum(m[4]),
          });
          return;
        }
        const e = p.pulses.onLine(line);
        if (e) this.routePulse(p.runId, e);
      },
    });
    p.tailer.start();
  }

  private pipelineSink(p: RunPipeline): RunSink {
    return {
      iter: (rec: IterRecord) => this.routeIter(p, rec),
      run: (c: RunCompletion) => this.completeRun(c),
      pulse: (e: PulseEvent) => {
        if (e.type === "meta") p.pulses.arm(e.meta);
        this.routePulse(p.runId, e);
      },
      promote: (info: PromoteInfo) => this.promptPromote(info),
    };
  }

  private displaySink(rec: RunRecord): RunSink {
    const rid = rec.runId;
    const p = this.pipelines.get(rid);
    return {
      iter: (r: IterRecord) => {
        this.registry.noteIter(rid, r.iter);
        postRunIteration(rid, r.iter, r.f_val, r.inf_pr, r.inf_du);
      },
      run: (c: RunCompletion) => {
        postRunCompletion(rid, c.fidelity ?? 0, this.registry.get(rid)?.latestIter ?? 0, c.status);
      },
      pulse: (e: PulseEvent) => {
        if (e.type === "meta") p?.pulses.arm(e.meta);
        this.routePulse(rid, e);
      },
      promote: (info: PromoteInfo) => this.promptPromote(info),
    };
  }

  private routeIter(p: RunPipeline, rec: IterRecord): void {
    p.dedup.noteIter(rec.iter);
    this.registry.noteIter(p.runId, rec.iter);
    postRunIteration(p.runId, rec.iter, rec.f_val, rec.inf_pr, rec.inf_du);
  }

  private routePulse(runId: string, e: PulseEvent): void {
    if (e.type === "meta") {
      postRunPulseMeta(runId, {
        drives: e.meta.drives,
        knots: e.meta.knots,
        labels: e.meta.labels,
        bounds: e.meta.bounds,
        interp: e.meta.interp,
      });
    } else {
      postRunPulse(runId, e.record.iter, e.record.dt, e.record.values);
    }
  }

  private checkFinished(p: RunPipeline): void {
    if (p.finishedSeen) return;
    if (!fs.existsSync(path.join(p.runDir, "FINISHED"))) return;
    const t = this.readTerminal(p.runDir);
    if (!t) return;
    p.finishedSeen = true;
    this.completeRun({ runId: p.runId, runDir: p.runDir, ...t });
  }

  private completeRun(c: RunCompletion): void {
    const rec = this.registry.get(c.runId);
    if (!rec || rec.phase === "finished") return;
    this.registry.markFinished(c.runId, c.status, c.fidelity);
    const p = this.pipelines.get(c.runId);
    p?.dispose();
    this.pipelines.delete(c.runId);
    this.opts.channel.appendLine(
      `[runs] ${c.runId} ${c.status}${c.fidelity !== undefined ? ` F=${c.fidelity.toFixed(6)}` : ""}`,
    );
    if (c.status !== "completed") this.opts.channel.appendLine(`[runs] see ${path.join(rec.runDir, "run.log")}`);
    postRunCompletion(c.runId, c.fidelity ?? 0, rec.latestIter ?? 0, c.status);
    const result = readTomlSafe(path.join(rec.runDir, "result.toml"));
    const wallSeconds = typeof result?.wall_seconds === "number" ? result.wall_seconds : undefined;
    if (wallSeconds !== undefined) postRunTiming(c.runId, wallSeconds);
    this.opts.onRunFinished?.({ runId: c.runId, runDir: rec.runDir, status: c.status });
    if (c.status === "completed" && c.fidelity !== undefined && c.fidelity >= (this.opts.promoteThreshold ?? 0.99)) {
      this.promptPromote({ runId: c.runId, runDir: rec.runDir, fidelity: c.fidelity });
    }
  }

  private readTerminal(runDir: string): { status: RunStatus; fidelity?: number } | undefined {
    return readTerminalState(runDir, (why) => this.opts.channel.appendLine(`[runs] ${why}`));
  }

  private promptPromote(info: PromoteInfo): void {
    if (this.promotedRuns.has(info.runId)) return;
    this.promotedRuns.add(info.runId);
    void vscode.window.showInformationMessage(
      `Amicode: solve converged (F=${info.fidelity.toFixed(4)}). Use Amicode: Save pulse to save the pulse to a file.`,
    );
  }
}
