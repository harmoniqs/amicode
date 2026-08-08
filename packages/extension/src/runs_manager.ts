import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { getInspector } from "./run_inspector";
import { LogTailer } from "./log_tailer";
import { parseIndexLine, RunRegistry, type RunRecord } from "./run_registry";
import { parseMaxIter } from "./run_timing";
import { isCloudRun } from "./run_location";
import type { StatusBarManager } from "./status_bar";
import type { RunState, RunStatus } from "./types";
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
import { STALL_AFTER_MS } from "./run_controls";

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
// auto-follows the newest started run (parity with β's latest-follow UX) —
// UNLESS a run was selected explicitly (selectRun pins; auto-follow defers),
// so a background solve can't yank the view off a deliberately-opened run.
//
// Completion keys on FINISHED (never result.toml presence); the contract
// reading is the pure `ingestRunDir`. Double-delivery between a selection
// replay and a live tail is tolerated by design — terminal state and the
// registry are idempotent, and the pulse/stats surfaces converge: the tailer
// may transiently re-deliver records OLDER than a replayed newest (plot/stats
// briefly regress) but every drain reads to EOF, so the last delivery is
// always the true newest (same rationale as the poll backstop).
//
// Scheduler (1.1, #56/#68): `attachScheduler` consumes the lifecycle stream —
// a `started` event registers the run immediately (faster than the index
// tail; also the only path for runs under a non-default runsRoot), with the
// same pin-aware auto-follow as index discovery.
// Structural type so this compiles independently of the Scheduler landing.
// ============================================================================

export interface RunsManagerOptions {
  runsRoot: string;
  channel: vscode.OutputChannel;
  statusBar?: StatusBarManager;
  promoteThreshold?: number;
  /** Live-only run-completion hook (spec-20260705-002847 §4.1 trigger 1) —
   *  fired at most once per run, from LIVE completions only (never the boot
   *  replay, which would re-trigger distills for historical runs). */
  onRunFinished?: (info: { runId: string; runDir: string; status: string }) => void;
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
  /** True once a run was selected EXPLICITLY (selectRun — demo command, 1.3
   *  user clicks). Auto-follow (a newly-registered live run taking the view,
   *  β latest-follow parity) only applies while NOT pinned — a background
   *  solve starting must never yank the view off a run the user deliberately
   *  opened (review #70; the seam 1.3's selection UI builds on). */
  private pinned = false;
  /** True during start()'s synchronous index replay — runs discovered at BOOT
   *  are registered/selected for state, but never reveal the inspector or show
   *  warming focus (only a run that starts while the user works should). */
  private booting = false;
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
    this.booting = true;
    this.indexTailer.start(); // synchronous initial drain — boot replay
    this.booting = false;
    this.rootWatcher = fs.watch(this.opts.runsRoot, { persistent: false }, (_e, filename) => {
      if (filename === "index") this.indexTailer?.poke();
    });
    // An unhandled FSWatcher 'error' is an uncaught exception in the extension
    // host (e.g. the watched dir deleted). The poll backstop keeps us live.
    this.rootWatcher.on("error", (e) => this.opts.channel.appendLine(`[runs] root watch error: ${String(e)}`));
    this.poll = setInterval(() => this.tick(), RunsManager.POLL_MS);
    this.opts.channel.appendLine(
      `[runs] watching ${this.opts.runsRoot}/index (fs.watch + ${RunsManager.POLL_MS}ms poll)`,
    );
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
      // Stall re-check for the SELECTED run: routeIter only fires when a line
      // arrives — which by definition means "not stalled" — so a run that
      // wedges mid-watch would keep "running · iter N" forever without this.
      // DOWNGRADE only (never stamps "running": warming/iter flow owns that).
      const sel = this.selected ? this.registry.get(this.selected) : undefined;
      if (
        sel &&
        sel.phase !== "finished" &&
        sel.latestIter !== undefined &&
        this.liveStatus(sel.runDir) === "stalled"
      ) {
        this.setRunState({
          runId: sel.runId,
          outputDir: sel.runDir,
          startedAt: 0,
          status: "stalled",
          latestIter: sel.latestIter,
        });
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

  /** Consume the #56 Scheduler lifecycle: `started` registers the run
   *  immediately (its runDir is authoritative — may live outside runsRoot);
   *  auto-follow applies unless an explicit selection is pinned. */
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

  /** EXPLICIT selection (demo replay command; 1.3's user clicks): makes
   *  `runId` the inspector's visible pane (`activate`) AND PINS the selection —
   *  after this, auto-follow never steals the view (see `pinned`).
   *
   *  Display: a run WITH a live pipeline was already fanned in runId-tagged
   *  (registration replay + live tail), so its pane is current — no re-ingest
   *  (review #70 #4). A run with NO pipeline (finished at discovery, or
   *  completed + torn down) was never fanned — replay it from disk into its
   *  pane. If FINISHED landed inside the ≤700ms poll window, the same-tick
   *  checkFinished below turns it into a real completion (badge + status bar),
   *  never a stale "running"/"warming". */
  selectRun(runId: string): void {
    const rec = this.registry.get(runId);
    if (!rec) return;
    this.pinned = true;
    if (this.selected === runId) return;
    this.selected = runId;
    const ins = getInspector();
    ins?.reveal();
    ins?.setRunLabel(runId, runId);
    if (isCloudRun(rec.runDir)) ins?.setCloudRun(runId);
    ins?.activate(runId); // 1.3: switch the visible pane
    const p = this.pipelines.get(runId);
    if (p) {
      // FINISHED may have landed inside the poll window — complete it NOW,
      // through the one completion mechanism, so the badge can't sit stale.
      this.checkFinished(p);
      // Point the single status bar at the selected run from registry state
      // (routeIter/completeRun keep it current from here).
      const r = this.registry.get(runId)!;
      this.setRunState({
        runId,
        outputDir: r.runDir,
        startedAt: 0,
        status: r.phase === "finished" ? (r.status ?? "completed") : this.liveStatus(r.runDir),
        latestIter: r.latestIter,
        fidelity: r.fidelity,
      });
    } else {
      // Never fanned (no pipeline) — display replay from disk (late-join safe).
      // Promote inside the replay stays guarded by promotedRuns, so
      // re-selecting a finished run never re-pops the prompt.
      try {
        ingestRunDir(rec.runDir, this.displaySink(rec), this.opts.promoteThreshold ?? 0.99);
      } catch (err) {
        this.opts.channel.appendLine(`[runs] replay failed: ${(err as Error).message}`);
      }
    }
    // Fresh/live run → Julia warming up. Disk-checked (FINISHED may exist while
    // the registry still says live); the host's setWarmingUp also no-ops if the
    // pane already carries data/terminal state (host guard).
    if (this.registry.get(runId)?.phase !== "finished" && !fs.existsSync(path.join(rec.runDir, "FINISHED"))) {
      ins?.setWarmingUp(runId);
    }
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

  /** The selected run's dir — the target for the Run Inspector's Stop / Save /
   *  Open controls (ported from the single-run watcher's activeRunDir). */
  getActiveRunDir(): string | undefined {
    return this.selected ? this.registry.get(this.selected)?.runDir : undefined;
  }

  /** The active run as a POINTER (amicode#250's bug-report envelope): the
   *  registry runId — relative to the runs root by construction, never an
   *  absolute path. undefined when no run is selected. */
  getActiveRunPointer(): string | undefined {
    return this.selected ? this.registry.get(this.selected)?.runId : undefined;
  }

  /** Release an explicit pin and resume latest-follow: jump to the newest LIVE
   *  run if one exists (registration order = creation order), else stay put.
   *  Backs the run picker's "Follow latest" entry. */
  resumeAutoFollow(): void {
    this.pinned = false;
    const live = this.registry.all().filter((r) => r.phase === "live");
    const newest = live[live.length - 1];
    if (newest && this.selected !== newest.runId) {
      // Route through selectRun for the full display path, then re-release the
      // pin it sets (this is the auto lane, not an explicit selection).
      this.selectRun(newest.runId);
      this.pinned = false;
    }
  }

  // -------- internal --------

  private registerRun(runId: string, runDir: string, createdAt?: string, scriptPath?: string): void {
    if (this.registry.get(runId)) {
      // Idempotent — the index replays from 0 every launch. But a run first
      // registered off the Scheduler's `started` event (runId+runDir only)
      // gains its createdAt/scriptPath when the index line lands here.
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
        // Terminal at discovery: record it (status/fidelity for the registry) but
        // render nothing and never re-pop the promote prompt (β launch parity).
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
      // FINISHED present but torn/invalid (caught mid-write) — do NOT finalize
      // with an undefined status that nothing revisits (review #70): fall
      // through to the live path, whose checkFinished re-reads next tick (the
      // same retry the live lane already has). Promote stays suppressed:
      // terminal-at-discovery is a launch replay regardless of the torn write.
      this.promotedRuns.add(runId);
    }
    this.registry.register({ runId, runDir, createdAt, scriptPath, phase: "live" });
    const p = new RunPipeline(runId, runDir);
    this.pipelines.set(runId, p);

    // Timing base for the pane's elapsed/rate/ETA strip: created_at → live
    // elapsed; max_iter (parsed from the run's actual script) → ETA. Best-effort.
    {
      const manifest = readTomlSafe(path.join(runDir, "run.toml"));
      const createdAtMs = manifest?.created_at ? Date.parse(String(manifest.created_at)) : NaN;
      let maxIter: number | undefined;
      try {
        if (manifest?.script_path) maxIter = parseMaxIter(fs.readFileSync(String(manifest.script_path), "utf8"));
      } catch {
        /* script gone */
      }
      getInspector()?.postTiming(runId, {
        createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : undefined,
        maxIter,
        terminal: false,
      });
    }

    // Auto-follow BEFORE the replay (β latest-follow parity: a newly REGISTERED
    // live run is by definition the newest start) — unless an explicit selection
    // is pinned. The single ingest below fans the run's history into ITS pane
    // regardless (1.3 fan-out); following just decides which pane is visible
    // (review #70 #4: the old shape parsed the whole run.log twice per
    // discovery — a state pass, then selectRun's display pass).
    const follow = !this.pinned;
    if (follow && this.selected !== runId) {
      this.selected = runId;
      const ins = getInspector();
      if (!this.booting) ins?.reveal(); // boot replay must not steal focus
      ins?.setRunLabel(runId, runId);
      const rdir = this.registry.get(runId)?.runDir;
      if (rdir && isCloudRun(rdir)) ins?.setCloudRun(runId);
      ins?.activate(runId);
    }

    // Single replay: arms the pipeline's pulse stream (meta), seeds iter
    // high-water, fans history runId-tagged, and yields the byte offset the
    // live tail starts from.
    let logBytes = 0;
    try {
      logBytes = ingestRunDir(runDir, this.pipelineSink(p), this.opts.promoteThreshold ?? 0.99);
    } catch (err) {
      this.opts.channel.appendLine(`[runs] replay failed: ${(err as Error).message}`);
    }

    // FINISHED landed between the existsSync check and the replay (rare race):
    // completeRun already tore the pipeline down (and — selection was assigned
    // above — showed the completion); don't attach watch/tail to a disposed
    // pipeline.
    if (this.registry.get(runId)?.phase === "finished") return;

    // Incremental: FINISHED (authoritative terminal), then appended log lines.
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

    // Fresh/live run with no data yet → Julia warming up (post-replay, β order).
    // Disk-checked: a torn FINISHED (fall-through above) must not read "warming".
    if (follow && !this.booting && !fs.existsSync(path.join(runDir, "FINISHED"))) {
      getInspector()?.setWarmingUp(runId);
    }
  }

  /** Sink for a pipeline's SINGLE registration replay: seeds registry/pulse
   *  state AND fans the history into the inspector runId-tagged through
   *  routeIter/routePulse (1.3 fan-out — the run's pane buffers it even while
   *  hidden), so no second display ingest is needed (review #70 #4). */
  private pipelineSink(p: RunPipeline): RunSink {
    return {
      iter: (rec: IterRecord) => this.routeIter(p, rec),
      // A FINISHED that landed between the existsSync check and this replay —
      // rare race; treat exactly like a live completion (fans out + promotes).
      run: (c: RunCompletion) => this.completeRun(c), // whole object — see completeRun (#84 seam)
      pulse: (e: PulseEvent) => {
        if (e.type === "meta") p.pulses.arm(e.meta);
        this.routePulse(p.runId, e);
      },
      promote: (info: PromoteInfo) => this.promptPromote(info),
    };
  }

  /** Display sink for a selection replay: posts the run's history into ITS pane
   *  (runId-tagged) + points the status bar at it; promote stays guarded. For a
   *  still-live run, meta also re-arms the pipeline stream (redundant with
   *  registration but harmless). */
  private displaySink(rec: RunRecord): RunSink {
    const rid = rec.runId;
    const p = this.pipelines.get(rid);
    return {
      iter: (r: IterRecord) => {
        this.registry.noteIter(rid, r.iter);
        getInspector()?.postIterationRecord(rid, r);
        // A finished run's replay must not stamp running/stalled per line — its
        // completion event (below) sets the bar exactly once at the end.
        if (this.registry.get(rid)?.phase !== "finished") {
          this.setRunState({
            runId: rid,
            outputDir: rec.runDir,
            startedAt: 0,
            status: this.liveStatus(rec.runDir),
            latestIter: r.iter,
          });
        }
      },
      run: (c: RunCompletion) => {
        getInspector()?.postCompletion(rid, c.status, c.fidelity);
        this.setRunState({
          runId: rid,
          outputDir: rec.runDir,
          startedAt: 0,
          status: c.status,
          latestIter: this.registry.get(rid)?.latestIter,
          fidelity: c.fidelity,
        });
      },
      pulse: (e: PulseEvent) => {
        if (e.type === "meta") p?.pulses.arm(e.meta);
        getInspector()?.postPulse(rid, e);
      },
      promote: (info: PromoteInfo) => this.promptPromote(info),
    };
  }

  /** The one seam that reaches the status bar, so "this run is in the cloud" is
   *  stamped in ONE place instead of at six call sites — the six that exist today
   *  are how a per-site flag would end up set on five of them and quietly missing
   *  on the sixth. Callers pass what they know; location is derived from the run
   *  dir, which is the authority for it. */
  private setRunState(state: RunState): void {
    this.opts.statusBar?.setRun({ ...state, cloud: this.isCloud(state.outputDir) });
  }

  /** Cached like liveStatus below, and for the same reason (this rides the
   *  per-iteration path). Cached FOREVER rather than on a TTL: remote.json is
   *  written once at submit and never removed, so the answer cannot change for a
   *  given run dir. */
  private readonly cloudCache = new Map<string, boolean>();
  private isCloud(runDir: string): boolean {
    let hit = this.cloudCache.get(runDir);
    if (hit === undefined) {
      hit = isCloudRun(runDir);
      this.cloudCache.set(runDir, hit);
    }
    return hit;
  }

  /** "running" only if run.log is actually moving. A FINISHED-less run whose
   *  log has been silent >10 min is wedged (OOM, killed host) — never let a
   *  boot replay of its old iter lines stamp "running · iter N" on the status
   *  bar forever. Mirrors the fork's isStalled (problems.ts, one-spine).
   *  2s TTL cache: a boot replay delivers thousands of iter lines back-to-back
   *  and must not pay one statSync per line. */
  private readonly liveStatusCache = new Map<string, { at: number; val: "running" | "stalled" }>();
  private liveStatus(runDir: string): "running" | "stalled" {
    const now = Date.now();
    const hit = this.liveStatusCache.get(runDir);
    if (hit && now - hit.at < 2000) return hit.val;
    let val: "running" | "stalled" = "running";
    try {
      if (now - fs.statSync(path.join(runDir, "run.log")).mtimeMs > STALL_AFTER_MS) val = "stalled";
    } catch {
      /* no run.log yet — brand-new run, trust the tailer */
    }
    this.liveStatusCache.set(runDir, { at: now, val });
    return val;
  }

  private routeIter(p: RunPipeline, rec: IterRecord): void {
    p.dedup.noteIter(rec.iter);
    this.registry.noteIter(p.runId, rec.iter);
    // 1.3 fan-out: every run's iters go to the inspector runId-tagged (the
    // webview updates that run's pane; only the active pane is visible — no
    // cross-talk). The single status bar tracks the SELECTED run only.
    getInspector()?.postIterationRecord(p.runId, rec);
    if (this.selected === p.runId) {
      // Live status-bar update — "running · iter N" as it solves (#5 AC3).
      this.setRunState({
        runId: p.runId,
        outputDir: p.runDir,
        startedAt: 0,
        status: this.liveStatus(p.runDir),
        latestIter: rec.iter,
      });
    }
  }

  private routePulse(runId: string, e: PulseEvent): void {
    // Fan out to every run's pane (runId-tagged); the webview shows only the
    // active pane. A background run's pulse never touches the visible plot.
    getInspector()?.postPulse(runId, e);
  }

  private checkFinished(p: RunPipeline): void {
    if (p.finishedSeen) return;
    if (!fs.existsSync(path.join(p.runDir, "FINISHED"))) return;
    const t = this.readTerminal(p.runDir);
    if (!t) return; // torn/invalid FINISHED — next tick retries
    p.finishedSeen = true;
    this.completeRun({ runId: p.runId, runDir: p.runDir, ...t });
  }

  /** Terminal handling for ANY run, selected or not: registry, teardown,
   *  channel, inspector/status-bar (selected only), promote (any run, once).
   *
   *  Takes the WHOLE RunCompletion (never exploded into positional fields) —
   *  this is the #84 seam: every completion path (ingestRunDir replay, live
   *  checkFinished) funnels the object built by ONE shared read, so an
   *  additive contract field (#81's `formulation` next, then #64 hashing /
   *  #41 usage) reaches every consumer by construction instead of being
   *  re-plumbed per path. Consumers cherry-pick at the leaf, not mid-pipe. */
  private completeRun(c: RunCompletion): void {
    const rec = this.registry.get(c.runId);
    if (!rec || rec.phase === "finished") return; // idempotent (watch + poll can both fire)
    this.registry.markFinished(c.runId, c.status, c.fidelity);
    const p = this.pipelines.get(c.runId);
    p?.dispose();
    this.pipelines.delete(c.runId);
    this.opts.channel.appendLine(
      `[runs] ${c.runId} ${c.status}${c.fidelity !== undefined ? ` F=${c.fidelity.toFixed(6)}` : ""}`,
    );
    if (c.status !== "completed") this.opts.channel.appendLine(`[runs] see ${path.join(rec.runDir, "run.log")}`);
    // Terminal state to the inspector for EVERY run (its pane's badge stops
    // saying "running" even in the background); status bar for the selected run.
    getInspector()?.postCompletion(c.runId, c.status, c.fidelity);
    // Freeze the elapsed strip at the recorded wall time (now − created_at
    // would overshoot for a run that finished before the panel opened).
    const result = readTomlSafe(path.join(rec.runDir, "result.toml"));
    const wallSeconds = typeof result?.wall_seconds === "number" ? result.wall_seconds : undefined;
    getInspector()?.postTiming(c.runId, { wallSeconds, terminal: true });
    this.opts.onRunFinished?.({ runId: c.runId, runDir: rec.runDir, status: c.status });
    if (this.selected === c.runId) {
      this.setRunState({
        runId: c.runId,
        outputDir: rec.runDir,
        startedAt: 0,
        status: c.status,
        latestIter: rec.latestIter,
        fidelity: c.fidelity,
      });
    }
    if (c.status === "completed" && c.fidelity !== undefined && c.fidelity >= (this.opts.promoteThreshold ?? 0.99)) {
      this.promptPromote({ runId: c.runId, runDir: rec.runDir, fidelity: c.fidelity });
    }
  }

  /** FINISHED (+ result.toml fidelity) with the same validation + say-why
   *  logging as β (S4: a present-but-invalid result.toml is named, not
   *  silently dropped). */
  private readTerminal(runDir: string): { status: RunStatus; fidelity?: number } | undefined {
    // Delegates to the reader's single orchestration point (review #70 — the
    // FINISHED→result.toml sequence must not be maintained twice); only the
    // say-why channel is manager-specific.
    return readTerminalState(runDir, (why) => this.opts.channel.appendLine(`[runs] ${why}`));
  }

  private promptPromote(info: PromoteInfo): void {
    if (this.promotedRuns.has(info.runId)) return;
    this.promotedRuns.add(info.runId);
    void (async () => {
      const choice = await vscode.window.showInformationMessage(
        `Amicode: solve converged (F=${info.fidelity.toFixed(4)}). Promote pulse to catalog?`,
        "Yes — promote",
        "No — keep local only",
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
