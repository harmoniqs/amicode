// packages/amico-run/src/remote_executor.ts
// Δ8 (#32): the cloud executor. Submits via Δ2, then MIRRORS the cloud run
// into a contract-conforming local run dir fed by the Δ4 poll endpoints —
// so every downstream reader (Scheduler S12, RunsManager index tail, run.log
// tail + poll backstop, FINISHED watch, stopPlan) consumes remote runs with
// ZERO executor branches. Locked resolutions: (a) frames best-effort,
// (b) abort()=request, (c) executor-owned warming budget, (d) terminal via
// status poll — FINISHED authoritative, instance-gone → inferred terminal.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { EventQueue } from "./event_queue.js";
import { classifyLine } from "./telemetry.js";
import {
  appendIndex,
  atomicWriteFile,
  defaultRunsRoot,
  deriveLabId,
  generateRunId,
  updateLatest,
  writeFinished,
  writeManifest,
} from "./run_dir.js";
import { readRemoteConfig, type RemoteConfig } from "./remote_config.js";
import {
  ConfigError,
  type Executor,
  type Finished,
  type RunEvent,
  type RunHandle,
  type RunStatus,
  type SubmitOpts,
} from "./types.js";
import pkg from "../package.json" with { type: "json" };

const ORCHESTRATOR_VERSION = pkg.version;

/** The remote status payload carries no exit code; mirror launch.ts's
 *  status→exit lanes. Inferred terminals (resolution (d)) use 255. */
const EXIT: Record<RunStatus, number> = { completed: 0, failed: 1, aborted: 130 };
export const EXIT_INFERRED = 255;

export interface RemoteExecutorOpts {
  /** Endpoint + credential; default readRemoteConfig() (env pair → ~/.amico/cloud.json). */
  config?: RemoteConfig;
  /** Poll cadence, default 2000ms. Test knob (the graceMs idiom, types.ts:13) — NOT exposed in the CLI. */
  pollMs?: number;
  /** Resolution (c): per-executor warming budget — no sign of life (Running
   *  status or a first iter) within this window → inferred terminal.
   *  Default 15 min: remote cold-start ≫ local seconds. */
  warmingBudgetMs?: number;
  /** Client half of resolution (d): no SUCCESSFUL status poll for this long →
   *  inferred terminal (observability lost; S3 keeps the cloud truth).
   *  Default 10 min — deliberately the inspector's STALL_AFTER_MS. */
  lostAfterMs?: number;
  /** Δ2 pass-through: overridable wall-clock cap (seconds). */
  maxWallclock?: number;
}

export class RemoteExecutor implements Executor {
  private readonly cfgOverride?: RemoteConfig;
  private readonly pollMs: number;
  private readonly warmingBudgetMs: number;
  private readonly lostAfterMs: number;
  private readonly maxWallclock?: number;

  constructor(opts: RemoteExecutorOpts = {}) {
    this.cfgOverride = opts.config;
    this.pollMs = opts.pollMs ?? 2000;
    this.warmingBudgetMs = opts.warmingBudgetMs ?? 15 * 60 * 1000;
    this.lostAfterMs = opts.lostAfterMs ?? 10 * 60 * 1000;
    this.maxWallclock = opts.maxWallclock;
  }

  async submit(scriptPath: string | undefined, opts: SubmitOpts = {}): Promise<RunHandle> {
    // ---- step 1 (LocalExecutor §5 parity): validate config; NO run dir on failure ----
    // v4 problem_spec routing is local-only for now (cloud-side solve_spec is a
    // Phase-4 follow-up); reject it here rather than silently ignore.
    if (opts.spec?.problem_spec !== undefined)
      throw new ConfigError("problem_spec is not yet supported with --executor remote (local-only in Phase 2)");
    if (scriptPath === undefined) throw new ConfigError("no script given");
    const script = resolve(scriptPath);
    if (!existsSync(script)) throw new ConfigError(`script not found: ${script}`);
    const cfg = this.cfgOverride ?? readRemoteConfig();
    const lab = opts.lab ?? "default";
    const labId = deriveLabId(lab);
    const runsRoot = opts.runsRoot ?? defaultRunsRoot(labId);

    // ---- step 2: Δ2 submit — still no run dir; a rejected submit ran nothing ----
    const payload: Record<string, unknown> = { script: readFileSync(script, "utf8"), filename: basename(script) };
    if (this.maxWallclock !== undefined) payload.max_wallclock = this.maxWallclock;
    let res: Response;
    try {
      res = await fetch(`${cfg.baseUrl}/solves`, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw new Error(`cloud submit failed: ${(e as Error).message}`);
    }
    // 401 is config-class (bad credential): the exit-64 lane, like a bad --julia path.
    if (res.status === 401)
      throw new ConfigError("cloud credential rejected (401) — check AMICO_CLOUD_TOKEN / cloud.json");
    if (res.status !== 202) throw new Error(`cloud submit: unexpected HTTP ${res.status}`);
    const taskId = String(((await res.json()) as { task_id?: unknown }).task_id ?? "");
    if (taskId === "") throw new Error("cloud submit: 202 without task_id");

    // ---- step 3: local MIRROR run dir — the same contract files LocalExecutor
    // writes (its steps 2–5), so downstream needs zero executor branches (S12).
    try {
      mkdirSync(runsRoot, { recursive: true });
    } catch (e) {
      throw new ConfigError(`runs root not writable: ${runsRoot} (${(e as Error).message})`);
    }
    const runId = generateRunId(runsRoot);
    const runDir = join(runsRoot, runId);
    mkdirSync(runDir);
    const createdAt = new Date().toISOString();
    writeManifest(runDir, {
      schema_version: "1",
      run_id: runId,
      script_path: script,
      lab,
      lab_id: labId,
      created_at: createdAt,
      orchestrator_version: ORCHESTRATOR_VERSION,
      julia: { binary: "cloud" }, // the runner image owns the real binary; run.schema.json requires the key
    });
    // task_id lives in a SIDECAR: run.schema.json is additionalProperties:false (frozen contract).
    atomicWriteFile(runDir, "remote.json", JSON.stringify({ task_id: taskId, base_url: cfg.baseUrl }) + "\n");
    writeFileSync(join(runDir, "run.log"), ""); // exists from t0 — stall logic keys off its mtime
    appendIndex(runsRoot, runId, createdAt, script);
    updateLatest(runsRoot, runId);

    // ---- step 4: the poll pump feeds the RunHandle ----
    const events = new EventQueue<RunEvent>();
    let resolveFinished!: (f: Finished) => void;
    const finished = new Promise<Finished>((r) => {
      resolveFinished = r;
    });
    let settled = false;
    let sawLife = false; // Running status or a first iter observed (warming budget clock)
    let iterHigh = -1; // stats high-water: Δ4 re-serves history each poll; dedup here
    let frameHigh = -1; // frames high-water
    let lastOkPollAt = Date.now(); // resolution (d) client half: observability clock
    const startedAt = Date.now();

    /** run.log line + event — byte-for-byte the LocalExecutor onLine path
     *  (local_executor.ts:139-145): log first, then classifyLine → push. */
    const emitLine = (line: string): void => {
      appendFileSync(join(runDir, "run.log"), line + "\n");
      events.push(classifyLine(line, "stdout"));
    };

    const settle = (status: RunStatus, exitCode: number): void => {
      if (settled) return;
      settled = true;
      try {
        writeFinished(runDir, status, exitCode); // atomic; the mirror's authoritative verdict
      } catch (e) {
        process.stderr.write(`amico-run: failed to write FINISHED: ${(e as Error).message}\n`);
      }
      events.push({ kind: "finished", status, exitCode });
      events.close();
      resolveFinished({ status, exitCode });
    };

    const get = (path: string): Promise<Response> =>
      fetch(`${cfg.baseUrl}/solves/${taskId}/${path}`, { headers: { authorization: `Bearer ${cfg.token}` } });

    let abortPosted = false;
    const postAbort = async (): Promise<void> => {
      if (abortPosted) return; // idempotent, like LocalExecutor's settled-guard
      abortPosted = true;
      try {
        await fetch(`${cfg.baseUrl}/solves/${taskId}/abort`, {
          method: "POST",
          headers: { authorization: `Bearer ${cfg.token}` },
        });
      } catch {
        /* the request is best-effort; the status poll still owns the terminal */
      }
    };

    const pollOnce = async (): Promise<void> => {
      // status — the authoritative terminal lane (resolution (d))
      const sres = await get("status");
      if (!sres.ok) throw new Error(`status HTTP ${sres.status}`);
      const s = (await sres.json()) as {
        task_status?: string;
        finished?: { status?: string };
        liveness?: string;
      };
      lastOkPollAt = Date.now();
      if (s.task_status === "Running") sawLife = true;
      // stats → synthesized AMICODE_ITER lines: run.log + events, the exact
      // local delivery path, so tail/backstop consumers can't tell the difference.
      try {
        const r = await get("stats");
        if (r.ok) {
          const stats = (await r.json()) as { iters?: Array<Record<string, unknown>> };
          for (const it of stats.iters ?? []) {
            const n = Number(it.iter);
            if (!Number.isFinite(n) || n <= iterHigh) continue; // Δ4 re-serves history: dedup on high-water
            iterHigh = n;
            sawLife = true;
            emitLine(`AMICODE_ITER iter=${it.iter} f=${it.f} inf_pr=${it.inf_pr} inf_du=${it.inf_du}`);
          }
        }
      } catch {
        /* stats are advisory — status stays the authoritative lane */
      }
      // frames — resolution (a): best-effort; ANY failure is swallowed
      try {
        const r = await get("frames");
        if (r.ok && r.status !== 204) {
          const fr = (await r.json()) as { iter?: number; png_base64?: string };
          if (typeof fr.iter === "number" && fr.iter > frameHigh && typeof fr.png_base64 === "string") {
            frameHigh = fr.iter;
            const name = `iter_${String(fr.iter).padStart(3, "0")}.png`; // the S3 layout's iter_*.png
            const tmp = join(runDir, `.${name}.tmp`);
            writeFileSync(tmp, Buffer.from(fr.png_base64, "base64"));
            renameSync(tmp, join(runDir, name)); // atomic: no reader sees a torn png
          }
        }
      } catch {
        /* frames are best-effort by contract */
      }
      // heartbeat: a successful status poll proves the cloud channel is alive.
      // Mirror that into run.log's MTIME (content untouched) so the inspector's
      // disk-keyed stall logic (liveStatus/stopPlan, STALL_AFTER_MS) measures
      // CLOUD silence — remote warming stays the executor's budget (resolution (c)).
      try {
        const now = new Date();
        utimesSync(join(runDir, "run.log"), now, now);
      } catch {
        /* mirror deleted underneath us — the terminal lanes still settle */
      }
      // resolution (d): instance gone without FINISHED → inferred terminal
      if (s.liveness === "gone" && s.finished === undefined) {
        emitLine(`AMICODE_REMOTE_LOST instance gone without FINISHED (task ${taskId})`);
        settle("failed", EXIT_INFERRED);
        return;
      }
      const f = s.finished?.status;
      if (f === "completed" || f === "failed" || f === "aborted") settle(f, EXIT[f]);
    };

    const pump = async (): Promise<void> => {
      while (!settled) {
        try {
          await pollOnce();
        } catch {
          // transient poll failure: skip this tick. run.log's mtime is NOT
          // advanced, so a sustained outage honestly reads "stalled" downstream.
        }
        if (settled) return;
        // resolution (c): the executor OWNS its warming budget — no Scheduler
        // timer exists to do this (pinned by scheduler.test.ts:285).
        if (!sawLife && Date.now() - startedAt > this.warmingBudgetMs) {
          emitLine(`AMICODE_REMOTE_LOST warming budget exhausted (${this.warmingBudgetMs}ms, task ${taskId})`);
          void postAbort(); // best-effort: stop paying for the instance
          settle("failed", EXIT_INFERRED);
          return;
        }
        // resolution (d) client half: observability lost. S3 keeps the cloud
        // truth; the mirror records an inferred verdict + breadcrumb rather
        // than polling a dead endpoint forever (bounded pump).
        if (Date.now() - lastOkPollAt > this.lostAfterMs) {
          emitLine(`AMICODE_REMOTE_LOST poll endpoint unreachable for ${this.lostAfterMs}ms (task ${taskId})`);
          settle("failed", EXIT_INFERRED);
          return;
        }
        await new Promise((r) => setTimeout(r, this.pollMs));
      }
    };
    void pump();

    // resolution (b): abort REQUESTS termination; the run is live until the
    // status poll delivers the real terminal. Idempotent; never rejects.
    const abort = async (): Promise<void> => {
      if (settled) return;
      await postAbort();
      await finished;
    };

    return { runId, runDir, events, finished, abort };
  }
}
