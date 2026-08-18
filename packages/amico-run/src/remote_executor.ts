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
import { appendRecord, type ReceiptRecord } from "./ledger.js";
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
    // The wall-clock cap is NEVER optional (2026-08-18 GPU-plane pass): the
    // cloud bundle has no cooperative stop, so an uncapped run is a billing
    // hang by construction. Ladder: explicit > env > generous default (2h —
    // typical solves are minutes; hard two-mode problems < 1h; 2h covers the
    // legitimate tail without letting a wedged run outlive the day).
    const envCap = Number(process.env.AMICODE_REMOTE_MAX_WALLCLOCK_S);
    this.maxWallclock = opts.maxWallclock ?? (Number.isFinite(envCap) && envCap > 0 ? envCap : 7200);
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
    payload.max_wallclock = this.maxWallclock!; // always set — see the constructor ladder
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
    let pulseHigh = -1; // pulse high-water (AMICODE_PULSE iter=N); dedup like stats
    let pulseMetaEmitted = false; // AMICODE_PULSE_META has no iter — relay it once
    let lastOkPollAt = Date.now(); // resolution (d) client half: observability clock
    const startedAt = Date.now();

    /** run.log line + event — byte-for-byte the LocalExecutor onLine path
     *  (local_executor.ts:139-145): log first, then classifyLine → push. */
    const emitLine = (line: string): void => {
      appendFileSync(join(runDir, "run.log"), line + "\n");
      events.push(classifyLine(line, "stdout"));
    };

    // #425 GPU receipt: the runner-contract fields ride the finished payload;
    // stashed here, consumed at settle. Absent fields → null → no receipt row
    // (nothing to account — the pre-contract runner emits none).
    type GpuReceipt = { gpu_sku?: string; gpu_seconds?: number; cost_usd?: number };
    let gpuReceipt: GpuReceipt | null = null;

    const settle = (status: RunStatus, exitCode: number): void => {
      if (settled) return;
      settled = true;
      try {
        writeFinished(runDir, status, exitCode); // atomic; the mirror's authoritative verdict
      } catch (e) {
        process.stderr.write(`amico-run: failed to write FINISHED: ${(e as Error).message}\n`);
      }
      // GPU accounting (#425): the receipt row is spend, not science —
      // emitted on FAILED runs too (they burn the same GPU time), never
      // feeding priors (no fidelity field exists on it by design).
      if (gpuReceipt) {
        try {
          const rec: ReceiptRecord = {
            type: "receipt",
            ts: new Date().toISOString(),
            task_id: taskId,
            executor: "remote",
            ...gpuReceipt,
          };
          if (status === "completed" || status === "failed" || status === "aborted") rec.status = status;
          appendRecord(rec); // validates against the ledger-record schema
          atomicWriteFile(runDir, "receipt.toml", [
            "# GPU receipt (runner contract #424) — mirrored from the cloud finished payload",
            `task_id = "${taskId}"`,
            ...(rec.gpu_sku ? [`gpu_sku = ${JSON.stringify(rec.gpu_sku)}`] : []),
            ...(rec.gpu_seconds !== undefined ? [`gpu_seconds = ${rec.gpu_seconds}`] : []),
            ...(rec.cost_usd !== undefined ? [`cost_usd = ${rec.cost_usd}`] : []),
            `status = "${status}"`,
          ].join("\n") + "\n");
        } catch (e) {
          process.stderr.write(`amico-run: failed to emit GPU receipt stanza: ${(e as Error).message}\n`);
        }
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
          // The live API serves `{task_id, stats: [...], submitter}`; the fake
          // served `{iters: [...]}`, and this read keyed only on `iters`. So every
          // REAL cloud solve emitted zero iter lines — silently, since the whole
          // block is best-effort — while the fake-backed tests passed. That drift
          // is what kept the run inspector empty for cloud runs (2026-07-28).
          // Both shapes are accepted so an older runner keeps working.
          const body = (await r.json()) as {
            stats?: Array<Record<string, unknown>>;
            iters?: Array<Record<string, unknown>>;
          };
          for (const it of body.stats ?? body.iters ?? []) {
            // Two record shapes, because the poller only JSON-decodes an
            // AMICODE_ITER payload that starts with "{". The solve template emits
            // the human/key=value form (`iter=7 f=… inf_pr=… inf_du=…`), which the
            // poller hands back verbatim as {raw}. Keying on `it.iter` alone
            // skipped every one of those as NaN — and the smoke test seeded JSON,
            // so nothing caught it. Reconstruct the line from whichever arrived.
            const raw = typeof it.raw === "string" ? it.raw : undefined;
            const n = Number(raw ? /(?:^|\s)iter=(\d+)/.exec(raw)?.[1] : it.iter);
            if (!Number.isFinite(n) || n <= iterHigh) continue; // Δ4 re-serves history: dedup on high-water
            iterHigh = n;
            sawLife = true;
            emitLine(
              raw
                ? `AMICODE_ITER ${raw}`
                : `AMICODE_ITER iter=${it.iter} f=${it.f} inf_pr=${it.inf_pr} inf_du=${it.inf_du}`,
            );
          }
        }
      } catch {
        /* stats are advisory — status stays the authoritative lane */
      }
      // pulse → AMICODE_PULSE_META (once) + AMICODE_PULSE lines: the SAME run.log
      // + events delivery as stats, so the inspector's pulse plot updates
      // progressively for a cloud run exactly as it does for a local one (the
      // render side already tails these off run.log). Mirrors _stats: the cloud
      // greps AMICODE_PULSE* out of the S3-synced run.log; the client dedups
      // (meta once — it carries no iter; pulse on the iter high-water, since Δ4
      // re-serves history each poll) and relays each new line verbatim so the
      // `a=` drive knots AND the `d=` derivative tail reach the plotter unaltered.
      // Best-effort: a runner/API without /pulse 404s here and is swallowed,
      // exactly like a pre-sidecar stats poll — the mirror just shows no pulse.
      try {
        const r = await get("pulse");
        if (r.ok && r.status !== 204) {
          const body = (await r.json()) as { pulse?: Array<{ raw?: unknown }> };
          for (const p of body.pulse ?? []) {
            const raw = typeof p.raw === "string" ? p.raw : undefined;
            if (raw === undefined) continue;
            if (raw.startsWith("AMICODE_PULSE_META")) {
              if (pulseMetaEmitted) continue; // one meta per run (no iter to dedup on)
              pulseMetaEmitted = true;
              sawLife = true;
              emitLine(raw);
              continue;
            }
            const n = Number(/(?:^|\s)iter=(\d+)/.exec(raw)?.[1]);
            if (!Number.isFinite(n) || n <= pulseHigh) continue; // dedup on high-water
            pulseHigh = n;
            sawLife = true;
            emitLine(raw);
          }
        }
      } catch {
        /* pulse is advisory — status stays the authoritative lane */
      }
      // frames — resolution (a): best-effort; ANY failure is swallowed
      try {
        const r = await get("frames");
        if (r.ok && r.status !== 204) {
          // Same drift as stats: the live API serves the newest frame as a
          // PRESIGNED URL (`{task_id, iter, key, url, submitter}`) because a png
          // is far too big to inline, while this read wanted `png_base64`. Fetch
          // the url when present (no auth header — the signature IS the auth),
          // and keep the base64 lane for older runners.
          const fr = (await r.json()) as { iter?: number; png_base64?: string; url?: string };
          if (typeof fr.iter === "number" && fr.iter > frameHigh) {
            let png: Buffer | undefined;
            if (typeof fr.png_base64 === "string") {
              png = Buffer.from(fr.png_base64, "base64");
            } else if (typeof fr.url === "string" && fr.url !== "") {
              const img = await fetch(fr.url);
              if (img.ok) png = Buffer.from(await img.arrayBuffer());
            }
            if (png) {
              frameHigh = fr.iter;
              // 5 digits — matches BOTH the S3 layout and what the local Julia
              // solve writes (iter_00060.png), so the inspector sees one naming
              // scheme regardless of where the solve ran. Was 3, which agreed
              // with neither.
              const name = `iter_${String(fr.iter).padStart(5, "0")}.png`;
              const tmp = join(runDir, `.${name}.tmp`);
              writeFileSync(tmp, png);
              renameSync(tmp, join(runDir, name)); // atomic: no reader sees a torn png
            }
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
      const fin = s.finished as
        | { status?: string; gpu_sku?: unknown; gpu_seconds?: unknown; cost_usd?: unknown }
        | undefined;
      if (fin && gpuReceipt === null) {
        const sku = typeof fin.gpu_sku === "string" && fin.gpu_sku !== "" ? fin.gpu_sku : undefined;
        const secs = typeof fin.gpu_seconds === "number" && Number.isFinite(fin.gpu_seconds) && fin.gpu_seconds > 0 ? fin.gpu_seconds : undefined;
        const cost = typeof fin.cost_usd === "number" && Number.isFinite(fin.cost_usd) && fin.cost_usd > 0 ? fin.cost_usd : undefined;
        if (sku !== undefined || secs !== undefined || cost !== undefined)
          gpuReceipt = { ...(sku !== undefined ? { gpu_sku: sku } : {}), ...(secs !== undefined ? { gpu_seconds: secs } : {}), ...(cost !== undefined ? { cost_usd: cost } : {}) };
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
