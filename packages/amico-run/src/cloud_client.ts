// packages/amico-run/src/cloud_client.ts
// The thin cloud client (#460, amico-run dissolution memo §4): the ONE piece of
// cloud code the Aug 17 rethink keeps — submit → poll → mirror — extracted once
// from RemoteExecutor so every caller (the RemoteExecutor adapter, the
// `amico cloud` verb, a future walk) talks to the solve service through ONE
// module. RemoteExecutor DELEGATES here with zero behavior change; the
// FakeCloud wire-shape tests (test/remote_executor.test.ts) and the executor
// parity suite pin that.
//
// Two layers, both reusable on their own:
//   CloudClient  — the wire: submit/status/stats/pulse/frames/abort over a
//                  RemoteConfig, carrying every documented wire-shape
//                  workaround exactly once (see the per-method comments).
//   CloudMirror  — the local run-dir mirror: one cloud task materialized as a
//                  contract-conforming run dir (run.log AMICODE_ITER/PULSE
//                  lines, iter_NNNNN.png frames, FINISHED, the #425 GPU
//                  receipt ledger row + receipt.toml).
//   cloudRun()   — the composing lifecycle (submit → mirror dir → poll pump
//                  → RunHandle): what RemoteExecutor.submit() delegates to and
//                  what `amico cloud run` calls.
//
// Locked resolutions carried here unchanged from Δ8: (a) frames best-effort,
// (b) abort()=request, (c) executor-owned warming budget, (d) terminal via
// status poll — FINISHED authoritative, instance-gone → inferred terminal.
//
// S31: THIS module is the one sanctioned network edge in amico-run (the
// exemption moved here from remote_executor.ts with the fetches, #460).
import { appendFileSync, mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { EventQueue } from "./event_queue.js";
import { appendRecord, type ReceiptRecord } from "./ledger.js";
import { classifyLine } from "./telemetry.js";
import {
  appendIndex,
  atomicWriteFile,
  generateRunId,
  updateLatest,
  writeFinished,
  writeManifest,
} from "./run_dir.js";
import type { RemoteConfig } from "./remote_config.js";
import { ConfigError, type Finished, type RunEvent, type RunHandle, type RunStatus } from "./types.js";
import pkg from "../package.json" with { type: "json" };

const ORCHESTRATOR_VERSION = pkg.version;

/** The remote status payload carries no exit code; mirror launch.ts's
 *  status→exit lanes. Inferred terminals (resolution (d)) use 255. */
const EXIT: Record<RunStatus, number> = { completed: 0, failed: 1, aborted: 130 };
export const EXIT_INFERRED = 255;

/** The wall-clock cap is NEVER optional (2026-08-18 GPU-plane pass): the cloud
 *  bundle has no cooperative stop, so an uncapped run is a billing hang by
 *  construction. Ladder: explicit > env > generous default (2h — typical solves
 *  are minutes; hard two-mode problems < 1h; 2h covers the legitimate tail
 *  without letting a wedged run outlive the day). Shared by RemoteExecutor and
 *  the `amico cloud` verb so the ladder lives once. */
export function wallclockCap(explicit?: number, env: NodeJS.ProcessEnv = process.env): number {
  if (explicit !== undefined) return explicit;
  const envCap = Number(env.AMICODE_REMOTE_MAX_WALLCLOCK_S);
  return Number.isFinite(envCap) && envCap > 0 ? envCap : 7200;
}

// ── the wire shapes ──────────────────────────────────────────────────────────────

/** The finished stanza off a status payload — the runner-contract receipt
 *  fields (#424/#425) ride it; every field is parsed defensively. */
export interface CloudFinished {
  status?: string;
  gpu_sku?: string;
  gpu_seconds?: number;
  cost_usd?: number;
}

/** GET /solves/{id}/status — the authoritative lane (resolution (d)). */
export interface CloudStatus {
  task_status?: string;
  finished?: CloudFinished;
  liveness?: string;
}

/** CloudClient — the thin HTTP half: one method per Δ2/Δ4 endpoint, pure over a
 *  RemoteConfig. Advisory endpoints (stats/pulse/frames) NEVER throw — status
 *  stays the authoritative lane; submit/abort follow their Δ2 contracts. */
export class CloudClient {
  constructor(readonly cfg: RemoteConfig) {}

  private solve(taskId: string, path: string): Promise<Response> {
    return fetch(`${this.cfg.baseUrl}/solves/${taskId}/${path}`, {
      headers: { authorization: `Bearer ${this.cfg.token}` },
    });
  }

  /** POST /solves — Δ2: script CONTENT + filename + the never-optional
   *  max_wallclock. 401 is config-class (bad credential): the exit-64 lane,
   *  like a bad --julia path. Non-202 or a 202 without task_id is a plain
   *  Error. Returns the task id. */
  async submitScript(script: string, filename: string, maxWallclock: number): Promise<string> {
    const payload: Record<string, unknown> = { script, filename };
    payload.max_wallclock = maxWallclock; // always set — see wallclockCap's ladder
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}/solves`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.cfg.token}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw new Error(`cloud submit failed: ${(e as Error).message}`);
    }
    if (res.status === 401)
      throw new ConfigError("cloud credential rejected (401) — check AMICO_CLOUD_TOKEN / cloud.json");
    if (res.status !== 202) throw new Error(`cloud submit: unexpected HTTP ${res.status}`);
    const taskId = String(((await res.json()) as { task_id?: unknown }).task_id ?? "");
    if (taskId === "") throw new Error("cloud submit: 202 without task_id");
    return taskId;
  }

  /** GET /solves/{id}/status — THROWS on a failed poll (the caller decides
   *  transient-skip vs terminal); every other client method is best-effort. */
  async status(taskId: string): Promise<CloudStatus> {
    const res = await this.solve(taskId, "status");
    if (!res.ok) throw new Error(`status HTTP ${res.status}`);
    return (await res.json()) as CloudStatus;
  }

  /** GET /solves/{id}/stats → reconstructed AMICODE_ITER lines with their parsed
   *  iter numbers (the mirror dedups on the high-water). Full history is
   *  re-served each poll; malformed records are skipped, never emitted as NaN. */
  async iterLines(taskId: string): Promise<Array<{ iter: number; line: string }>> {
    try {
      const r = await this.solve(taskId, "stats");
      if (!r.ok) return [];
      // The live API serves `{task_id, stats: [...], submitter}`; the fake
      // served `{iters: [...]}`, and the original read keyed only on `iters`. So
      // every REAL cloud solve emitted zero iter lines — silently, since the
      // whole block is best-effort — while the fake-backed tests passed. That
      // drift is what kept the run inspector empty for cloud runs (2026-07-28).
      // Both shapes are accepted so an older runner keeps working.
      const body = (await r.json()) as {
        stats?: Array<Record<string, unknown>>;
        iters?: Array<Record<string, unknown>>;
      };
      const out: Array<{ iter: number; line: string }> = [];
      for (const it of body.stats ?? body.iters ?? []) {
        // Two record shapes, because the poller only JSON-decodes an
        // AMICODE_ITER payload that starts with "{". The solve template emits
        // the human/key=value form (`iter=7 f=… inf_pr=… inf_du=…`), which the
        // poller hands back verbatim as {raw}. Keying on `it.iter` alone
        // skipped every one of those as NaN — and the smoke test seeded JSON,
        // so nothing caught it. Reconstruct the line from whichever arrived.
        const raw = typeof it.raw === "string" ? it.raw : undefined;
        const n = Number(raw ? /(?:^|\s)iter=(\d+)/.exec(raw)?.[1] : it.iter);
        if (!Number.isFinite(n)) continue; // malformed → skipped, not NaN
        out.push({
          iter: n,
          line: raw
            ? `AMICODE_ITER ${raw}`
            : `AMICODE_ITER iter=${it.iter} f=${it.f} inf_pr=${it.inf_pr} inf_du=${it.inf_du}`,
        });
      }
      return out;
    } catch {
      return []; // stats are advisory — status stays the authoritative lane
    }
  }

  /** GET /solves/{id}/pulse → the raw AMICODE_PULSE_META / AMICODE_PULSE lines,
   *  verbatim (the cloud greps them out of the S3-synced run.log; never JSON,
   *  so always {raw}). Full history each poll — the mirror dedups. */
  async pulseLines(taskId: string): Promise<string[]> {
    try {
      const r = await this.solve(taskId, "pulse");
      if (!r.ok || r.status === 204) return [];
      const body = (await r.json()) as { pulse?: Array<{ raw?: unknown }> };
      const out: string[] = [];
      for (const p of body.pulse ?? []) {
        if (typeof p.raw === "string") out.push(p.raw);
      }
      return out;
    } catch {
      return []; // pulse is advisory — status stays the authoritative lane
    }
  }

  /** GET /solves/{id}/frames → the newest frame png. Best-effort: any failure
   *  (404, 204, 500, a dead presigned url) → undefined — resolution (a). */
  async frame(taskId: string): Promise<{ iter: number; png: Buffer } | undefined> {
    try {
      const r = await this.solve(taskId, "frames");
      if (!r.ok || r.status === 204) return undefined;
      // Same drift as stats: the live API serves the newest frame as a
      // PRESIGNED URL (`{task_id, iter, key, url, submitter}`) because a png
      // is far too big to inline, while the original read wanted `png_base64`.
      // Fetch the url when present (no auth header — the signature IS the auth),
      // and keep the base64 lane for older runners.
      const fr = (await r.json()) as { iter?: number; png_base64?: string; url?: string };
      if (typeof fr.iter !== "number") return undefined;
      let png: Buffer | undefined;
      if (typeof fr.png_base64 === "string") {
        png = Buffer.from(fr.png_base64, "base64");
      } else if (typeof fr.url === "string" && fr.url !== "") {
        const img = await fetch(fr.url);
        if (img.ok) png = Buffer.from(await img.arrayBuffer());
      }
      return png === undefined ? undefined : { iter: fr.iter, png };
    } catch {
      return undefined; // frames are best-effort by contract
    }
  }

  /** POST /solves/{id}/abort — resolution (b): a REQUEST. Best-effort and
   *  idempotent AT THE CALLER (the pump posts at most once per run); the
   *  status poll still owns the terminal. Never rejects. */
  async abort(taskId: string): Promise<void> {
    try {
      await fetch(`${this.cfg.baseUrl}/solves/${taskId}/abort`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.cfg.token}` },
      });
    } catch {
      /* the request is best-effort; the status poll still owns the terminal */
    }
  }
}

// ── the GPU receipt (#425/#430): pure spend, never feeding priors ────────────────

export interface GpuReceiptFields {
  gpu_sku?: string;
  gpu_seconds?: number;
  cost_usd?: number;
}

/** The runner-contract GPU fields off a finished payload, defensively parsed.
 *  null when the payload carries none (nothing to account — the pre-contract
 *  runner emits none). */
export function gpuReceiptOf(fin: CloudFinished): GpuReceiptFields | null {
  const sku = typeof fin.gpu_sku === "string" && fin.gpu_sku !== "" ? fin.gpu_sku : undefined;
  const secs =
    typeof fin.gpu_seconds === "number" && Number.isFinite(fin.gpu_seconds) && fin.gpu_seconds > 0
      ? fin.gpu_seconds
      : undefined;
  const cost =
    typeof fin.cost_usd === "number" && Number.isFinite(fin.cost_usd) && fin.cost_usd > 0 ? fin.cost_usd : undefined;
  if (sku === undefined && secs === undefined && cost === undefined) return null;
  return {
    ...(sku !== undefined ? { gpu_sku: sku } : {}),
    ...(secs !== undefined ? { gpu_seconds: secs } : {}),
    ...(cost !== undefined ? { cost_usd: cost } : {}),
  };
}

/** Emit the GPU receipt at settle: the #430 ledger row (validates against the
 *  ledger-record schema) + the mirror's durable receipt.toml. The row is
 *  spend, not science — emitted on FAILED runs too (they burn the same GPU
 *  time), never feeding priors (no fidelity field exists on it by design).
 *  Never throws: an accounting fault must not kill the terminal lanes. */
export function emitGpuReceipt(runDir: string, taskId: string, status: RunStatus, receipt: GpuReceiptFields): boolean {
  try {
    const rec: ReceiptRecord = {
      type: "receipt",
      ts: new Date().toISOString(),
      task_id: taskId,
      executor: "remote",
      ...receipt,
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
    return true;
  } catch (e) {
    process.stderr.write(`amico-run: failed to emit GPU receipt stanza: ${(e as Error).message}\n`);
    return false;
  }
}

// ── the mirror run dir (LocalExecutor steps 2–5 parity) ─────────────────────────

export interface MirrorDirArgs {
  cfg: RemoteConfig;
  taskId: string;
  /** The manifest's script_path. The executor path records the resolved local
   *  script; a one-shot mirror of an existing task has no local script, so it
   *  points at the cloud task (`cloud://<task_id>`) — run.schema.json requires
   *  a non-empty string. */
  script: string;
  lab: string;
  labId: string;
  runsRoot: string;
}

/** Create the local MIRROR run dir — the same contract files LocalExecutor
 *  writes, so downstream needs zero executor branches (S12): manifest, the
 *  remote.json sidecar (task_id lives there: run.schema.json is
 *  additionalProperties:false), run.log from t0 (stall logic keys off its
 *  mtime), index row, latest symlink. */
export function createMirrorRunDir(args: MirrorDirArgs): { runId: string; runDir: string } {
  try {
    mkdirSync(args.runsRoot, { recursive: true });
  } catch (e) {
    throw new ConfigError(`runs root not writable: ${args.runsRoot} (${(e as Error).message})`);
  }
  const runId = generateRunId(args.runsRoot);
  const runDir = join(args.runsRoot, runId);
  mkdirSync(runDir);
  const createdAt = new Date().toISOString();
  writeManifest(runDir, {
    schema_version: "1",
    run_id: runId,
    script_path: args.script,
    lab: args.lab,
    lab_id: args.labId,
    created_at: createdAt,
    orchestrator_version: ORCHESTRATOR_VERSION,
    julia: { binary: "cloud" }, // the runner image owns the real binary; run.schema.json requires the key
  });
  atomicWriteFile(runDir, "remote.json", JSON.stringify({ task_id: args.taskId, base_url: args.cfg.baseUrl }) + "\n");
  writeFileSync(join(runDir, "run.log"), ""); // exists from t0 — stall logic keys off its mtime
  appendIndex(args.runsRoot, runId, createdAt, args.script);
  updateLatest(args.runsRoot, runId);
  return { runId, runDir };
}

// ── the mirror: one cloud task → one contract run dir ────────────────────────────

export interface CloudMirrorArgs {
  client: CloudClient;
  taskId: string;
  runId: string;
  runDir: string;
  /** Streaming hook: every mirrored line also becomes a run event (the
   *  executor path classifies it; a one-shot mirror passes none). */
  onLine?: (line: string) => void;
  /** Settle hook: fired once, after FINISHED and the receipt are on disk. */
  onSettle?: (result: Finished) => void;
}

/** CloudMirror — the local half of a cloud run: it owns the run dir, the
 *  high-water dedup state, and the terminal lanes. pollOnce() is one full pass
 *  (status + advisory stats/pulse/frames + the run.log mtime heartbeat);
 *  settle() writes FINISHED, emits the GPU receipt, and reports via onSettle. */
export class CloudMirror {
  readonly taskId: string;
  readonly runId: string;
  readonly runDir: string;
  readonly startedAt = Date.now();
  /** Resolution (d) client half: the observability clock — updated on every
   *  successful status poll. */
  lastOkPollAt = Date.now();
  /** Life seen: a Running status or any iter/pulse line (resolution (c) clock). */
  sawLife = false;
  settled = false;
  /** The settled verdict, once settle() has run. */
  result: Finished | undefined;

  private readonly client: CloudClient;
  private readonly onLine?: (line: string) => void;
  private readonly onSettle?: (result: Finished) => void;
  private iterHigh = -1; // stats high-water: Δ4 re-serves history each poll; dedup here
  private frameHigh = -1; // frames high-water
  private pulseHigh = -1; // pulse high-water (AMICODE_PULSE iter=N); dedup like stats
  private pulseMetaEmitted = false; // AMICODE_PULSE_META has no iter — relay it once
  private gpuReceipt: GpuReceiptFields | null = null;

  constructor(args: CloudMirrorArgs) {
    this.client = args.client;
    this.taskId = args.taskId;
    this.runId = args.runId;
    this.runDir = args.runDir;
    this.onLine = args.onLine;
    this.onSettle = args.onSettle;
  }

  /** run.log line + event — byte-for-byte the LocalExecutor onLine path
   *  (local_executor.ts): log first, then classifyLine → push. */
  emitLine(line: string): void {
    appendFileSync(join(this.runDir, "run.log"), line + "\n");
    this.onLine?.(line);
  }

  /** One poll pass. Status is the authoritative terminal lane (resolution (d))
   *  and the ONLY thrower — a failed status poll propagates so the caller can
   *  skip the tick (transient) or fail honestly (one-shot). Stats/pulse/frames
   *  are advisory and swallowed individually, exactly as before. */
  async pollOnce(): Promise<CloudStatus> {
    // status — the authoritative terminal lane
    const s = await this.client.status(this.taskId);
    this.lastOkPollAt = Date.now();
    if (s.task_status === "Running") this.sawLife = true;
    // stats → synthesized AMICODE_ITER lines: run.log + events, the exact
    // local delivery path, so tail/backstop consumers can't tell the difference.
    try {
      for (const { iter, line } of await this.client.iterLines(this.taskId)) {
        if (iter <= this.iterHigh) continue; // Δ4 re-serves history: dedup on high-water
        this.iterHigh = iter;
        this.sawLife = true;
        this.emitLine(line);
      }
    } catch {
      /* stats are advisory — status stays the authoritative lane */
    }
    // pulse → AMICODE_PULSE_META (once) + AMICODE_PULSE lines: the SAME run.log
    // + events delivery as stats, so the inspector's pulse plot updates
    // progressively for a cloud run exactly as it does for a local one (the
    // render side already tails these off run.log). Each new line is relayed
    // verbatim so the `a=` drive knots AND the `d=` derivative tail reach the
    // plotter unaltered; meta once (no iter to dedup on), pulse on the iter
    // high-water. Best-effort: a runner/API without /pulse yields nothing.
    try {
      for (const raw of await this.client.pulseLines(this.taskId)) {
        if (raw.startsWith("AMICODE_PULSE_META")) {
          if (this.pulseMetaEmitted) continue; // one meta per run (no iter to dedup on)
          this.pulseMetaEmitted = true;
          this.sawLife = true;
          this.emitLine(raw);
          continue;
        }
        const n = Number(/(?:^|\s)iter=(\d+)/.exec(raw)?.[1]);
        if (!Number.isFinite(n) || n <= this.pulseHigh) continue; // dedup on high-water
        this.pulseHigh = n;
        this.sawLife = true;
        this.emitLine(raw);
      }
    } catch {
      /* pulse is advisory — status stays the authoritative lane */
    }
    // frames — resolution (a): best-effort; ANY failure is swallowed
    try {
      const fr = await this.client.frame(this.taskId);
      if (fr !== undefined && fr.iter > this.frameHigh) {
        // 5 digits — matches BOTH the S3 layout and what the local Julia
        // solve writes (iter_00060.png), so the inspector sees one naming
        // scheme regardless of where the solve ran. Was 3, which agreed
        // with neither.
        const name = `iter_${String(fr.iter).padStart(5, "0")}.png`;
        const tmp = join(this.runDir, `.${name}.tmp`);
        writeFileSync(tmp, fr.png);
        renameSync(tmp, join(this.runDir, name)); // atomic: no reader sees a torn png
        this.frameHigh = fr.iter;
      }
    } catch {
      /* frames are best-effort by contract */
    }
    // heartbeat: a successful status poll proves the cloud channel is alive.
    // Mirror that into run.log's MTIME (content untouched) so the inspector's
    // disk-keyed stall logic (liveStatus/stopPlan, STALL_AFTER_MS) measures
    // CLOUD silence — remote warming stays the caller's budget (resolution (c)).
    try {
      const now = new Date();
      utimesSync(join(this.runDir, "run.log"), now, now);
    } catch {
      /* mirror deleted underneath us — the terminal lanes still settle */
    }
    // resolution (d): instance gone without FINISHED → inferred terminal
    if (s.liveness === "gone" && s.finished === undefined) {
      this.emitLine(`AMICODE_REMOTE_LOST instance gone without FINISHED (task ${this.taskId})`);
      this.settle("failed", EXIT_INFERRED);
      return s;
    }
    // #425 GPU receipt: the runner-contract fields ride the finished payload;
    // stashed here, consumed at settle. Absent fields → null → no receipt row.
    if (s.finished !== undefined && this.gpuReceipt === null) {
      this.gpuReceipt = gpuReceiptOf(s.finished);
    }
    const f = s.finished?.status;
    if (f === "completed" || f === "failed" || f === "aborted") this.settle(f, EXIT[f]);
    return s;
  }

  /** Terminal: FINISHED (the mirror's authoritative verdict), the GPU receipt
   *  (ledger row + receipt.toml), then the settle hook. Idempotent. */
  settle(status: RunStatus, exitCode: number): void {
    if (this.settled) return;
    this.settled = true;
    try {
      writeFinished(this.runDir, status, exitCode); // atomic; the mirror's authoritative verdict
    } catch (e) {
      process.stderr.write(`amico-run: failed to write FINISHED: ${(e as Error).message}\n`);
    }
    if (this.gpuReceipt !== null) emitGpuReceipt(this.runDir, this.taskId, status, this.gpuReceipt);
    this.result = { status, exitCode };
    this.onSettle?.(this.result);
  }
}

// ── the composing lifecycle: submit → mirror dir → poll pump → RunHandle ────────

export interface CloudRunOpts {
  cfg: RemoteConfig;
  /** Resolved, existence-checked script path (the caller owns validation). */
  script: string;
  lab: string;
  labId: string;
  runsRoot: string;
  /** The never-optional wall-clock cap (seconds) — see wallclockCap. */
  maxWallclock: number;
  /** Poll cadence, default 2000ms. */
  pollMs?: number;
  /** Resolution (c): no sign of life within this window → inferred terminal.
   *  Default 15 min: remote cold-start ≫ local seconds. */
  warmingBudgetMs?: number;
  /** Resolution (d) client half: no successful status poll for this long →
   *  inferred terminal. Default 10 min — deliberately the inspector's
   *  STALL_AFTER_MS. */
  lostAfterMs?: number;
}

/** The full cloud lifecycle — the RemoteExecutor.submit() body, moved once
 *  (#460): Δ2 submit (still no run dir; a rejected submit ran nothing), the
 *  local mirror dir, then the poll pump feeding a RunHandle. */
export async function cloudRun(opts: CloudRunOpts): Promise<RunHandle> {
  const pollMs = opts.pollMs ?? 2000;
  const warmingBudgetMs = opts.warmingBudgetMs ?? 15 * 60 * 1000;
  const lostAfterMs = opts.lostAfterMs ?? 10 * 60 * 1000;
  const client = new CloudClient(opts.cfg);

  // Δ2 submit — still no run dir; a rejected submit ran nothing
  const taskId = await client.submitScript(readFileSync(opts.script, "utf8"), basename(opts.script), opts.maxWallclock);

  // local MIRROR run dir — the same contract files LocalExecutor writes
  const { runId, runDir } = createMirrorRunDir({
    cfg: opts.cfg,
    taskId,
    script: opts.script,
    lab: opts.lab,
    labId: opts.labId,
    runsRoot: opts.runsRoot,
  });

  // the poll pump feeds the RunHandle
  const events = new EventQueue<RunEvent>();
  let resolveFinished!: (f: Finished) => void;
  const finished = new Promise<Finished>((r) => {
    resolveFinished = r;
  });
  const mirror = new CloudMirror({
    client,
    taskId,
    runId,
    runDir,
    onLine: (line) => events.push(classifyLine(line, "stdout")),
    onSettle: (f) => {
      events.push({ kind: "finished", status: f.status, exitCode: f.exitCode });
      events.close();
      resolveFinished(f);
    },
  });

  let abortPosted = false;
  const postAbort = async (): Promise<void> => {
    if (abortPosted) return; // idempotent, like LocalExecutor's settled-guard
    abortPosted = true;
    await client.abort(taskId);
  };

  const pump = async (): Promise<void> => {
    while (!mirror.settled) {
      try {
        await mirror.pollOnce();
      } catch {
        // transient poll failure: skip this tick. run.log's mtime is NOT
        // advanced, so a sustained outage honestly reads "stalled" downstream.
      }
      if (mirror.settled) return;
      // resolution (c): the caller OWNS its warming budget — no Scheduler
      // timer exists to do this (pinned by scheduler.test.ts).
      if (!mirror.sawLife && Date.now() - mirror.startedAt > warmingBudgetMs) {
        mirror.emitLine(`AMICODE_REMOTE_LOST warming budget exhausted (${warmingBudgetMs}ms, task ${taskId})`);
        void postAbort(); // best-effort: stop paying for the instance
        mirror.settle("failed", EXIT_INFERRED);
        return;
      }
      // resolution (d) client half: observability lost. S3 keeps the cloud
      // truth; the mirror records an inferred verdict + breadcrumb rather
      // than polling a dead endpoint forever (bounded pump).
      if (Date.now() - mirror.lastOkPollAt > lostAfterMs) {
        mirror.emitLine(`AMICODE_REMOTE_LOST poll endpoint unreachable for ${lostAfterMs}ms (task ${taskId})`);
        mirror.settle("failed", EXIT_INFERRED);
        return;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  };
  void pump();

  // resolution (b): abort REQUESTS termination; the run is live until the
  // status poll delivers the real terminal. Idempotent; never rejects.
  const abort = async (): Promise<void> => {
    if (mirror.settled) return;
    await postAbort();
    await finished;
  };

  return { runId, runDir, events, finished, abort };
}
