/** Distill job queue + the single global distiller lock (spec-20260705-002847 §4.1).
 *
 *  Shared by BOTH runtimes: the extension (node) and the opencode plugin (Bun) —
 *  so: node:fs/node:path only, no vscode, no Bun APIs.
 *
 *  Lock protocol (reviewer-hardened, 4 rounds):
 *  - claim  = `mkdir distiller.lock` (atomic, EEXIST on contention — NEVER
 *    rename-onto-destination, which silently replaces an existing lock)
 *  - reclaim = rename the stale dir ASIDE (only one reclaimer's rename can
 *    succeed), then a normal mkdir claim — never remove-then-mkdir
 *  - drain  = winner processes the ENTIRE queue sequentially, releases, then
 *    RE-CHECKS the queue and re-claims if non-empty (closes the race where a
 *    loser's job lands after the final listing but before the release)
 *  - a failing job is set aside (kept, never deleted) and the drain continues
 *
 *  FAILURE POLICY (#2098, decided by the owner 2026-11-03): a failed job is
 *  retried 3 times with growing backoff; after the 4th failed attempt (the
 *  original run + 3 retries) it is PARKED — terminal, counted, never deleted,
 *  never retried automatically. The drain HALTS after 5 consecutive failures
 *  across DIFFERENT jobs; a success resets that count.
 *
 *  ON-DISK GRAMMAR — the only contract between this module and the CLI's
 *  read-only health reader (packages/amico-run/src/distill_health.ts parses it
 *  independently; keep the two in step). Files in `<ops>/distill-queue/`:
 *    <base>.json                READY. Strictly "offered now"; never rewritten.
 *    <base>.json.failed-<ms>    set aside after a failure at <ms>. WITH a ledger
 *                               it is backing off until the ledger's not_before.
 *                               WITHOUT a ledger it is the pre-#2098 format: one
 *                               prior attempt, unknown error, retry-eligible NOW.
 *    <base>.json.parked-<ms>    TERMINAL (4 failed attempts). Never offered.
 *    <base>.json.attempts       LEDGER (JSON): { attempt, last_error (<=500
 *                               chars), last_at, not_before }. Stable across
 *                               state renames; removed when the job succeeds.
 *  The job file's bytes are never rewritten (attempt state lives in the name +
 *  ledger), so a set-aside file is always the original job.
 *  Other files in `<ops>/`:
 *    distill-streak.json   { job_ids: string[] } — distinct jobs failed since
 *                          the last success. Removed on success / reset.
 *    distill-halt.json     { reason, at, consecutive, job_ids } — present iff the
 *                          drain is HALTED. While present no drain runs (nothing
 *                          is spent) until `resetDistillHalt`. */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";

export const STALE_LOCK_MS = 15 * 60 * 1000;
/** One distill job gets at most 10 min of LLM time before it's set aside. */
export const JOB_TIMEOUT_MS = 10 * 60 * 1000;
/** Delay before retry n (n = 1..3) after the n-th failed attempt: 10 min, 40 min, 160 min. */
export const RETRY_BACKOFF_MS = [10 * 60 * 1000, 40 * 60 * 1000, 160 * 60 * 1000];
/** Attempts before a job is parked: the original run plus one per backoff slot. */
export const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length + 1;
/** Consecutive failures across DIFFERENT jobs that halt the drain. */
export const HALT_AFTER = 5;
const MAX_ERROR_CHARS = 500;

export interface DistillJob {
  kind: "run" | "sweep" | "onboarding" | "batch";
  [key: string]: unknown;
}

export interface DrainClock {
  pid: number;
  now: () => number;
  isPidAlive: (pid: number) => boolean;
}

function queueDir(opsDir: string): string {
  return path.join(opsDir, "distill-queue");
}
function lockDir(opsDir: string): string {
  return path.join(opsDir, "distiller.lock");
}

let enqueueCounter = 0;

export function enqueueJob(opsDir: string, job: DistillJob): string {
  const dir = queueDir(opsDir);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${String(enqueueCounter++).padStart(4, "0")}-${job.kind}.json`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(job, null, 2) + "\n");
  return file;
}

export function listJobs(opsDir: string): string[] {
  try {
    return fs
      .readdirSync(queueDir(opsDir))
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => path.join(queueDir(opsDir), f));
  } catch {
    return [];
  }
}

export function queueIsEmpty(opsDir: string): boolean {
  return listJobs(opsDir).length === 0;
}

export function claimLock(opsDir: string, pid: number): boolean {
  fs.mkdirSync(opsDir, { recursive: true });
  try {
    fs.mkdirSync(lockDir(opsDir)); // no recursive: must fail EEXIST on contention
  } catch {
    return false;
  }
  fs.writeFileSync(path.join(lockDir(opsDir), "owner"), JSON.stringify({ pid, ts: Date.now() }) + "\n");
  return true;
}

export function releaseLock(opsDir: string): void {
  try {
    fs.rmSync(lockDir(opsDir), { recursive: true, force: true });
  } catch {
    /* released is released */
  }
}

/** Reclaim a stale lock (older than 15 min, dead pid) by renaming it aside —
 *  only one reclaimer's rename succeeds — then claiming fresh. Returns true if
 *  THIS caller now holds the lock. */
export function reclaimIfStale(
  opsDir: string,
  pid: number,
  clock: { now: number; isPidAlive: (pid: number) => boolean },
): boolean {
  let owner: { pid: number; ts: number };
  try {
    owner = JSON.parse(fs.readFileSync(path.join(lockDir(opsDir), "owner"), "utf8"));
  } catch {
    return false; // no lock (or unreadable — leave it to the 15-min clock)
  }
  if (clock.now - owner.ts <= STALE_LOCK_MS) return false;
  if (clock.isPidAlive(owner.pid)) return false;
  const aside = `${lockDir(opsDir)}.stale-${pid}-${clock.now}`;
  try {
    fs.renameSync(lockDir(opsDir), aside); // atomic: exactly one reclaimer wins the source
  } catch {
    return false; // someone else already renamed it aside
  }
  return claimLock(opsDir, pid);
}

export interface DrainHalt {
  reason: string;
  at: number;
  consecutive: number;
  job_ids: string[];
}

export interface DrainResult {
  /** Jobs the handler (or the parser) was invoked on this pass. */
  attempted: number;
  succeeded: number;
  failed: number;
  parked: number;
  /** Set when the drain is (now, or already) halted; remaining jobs untouched. */
  halted?: DrainHalt;
}

export interface DrainOpts {
  now?: () => number;
  /** Job bases already attempted in this drain loop — skipped, so one loop never
   *  offers the same job twice (bounds spend and rules out a spin). */
  attempted?: Set<string>;
}

interface Ledger {
  attempt: number;
  last_error: string;
  last_at: number;
  not_before: number;
}

const STATE_NAME = /^(.+\.json)(?:\.(failed|parked)-(\d+))?$/;

function ledgerPath(opsDir: string, base: string): string {
  return path.join(queueDir(opsDir), `${base}.attempts`);
}
function streakPath(opsDir: string): string {
  return path.join(opsDir, "distill-streak.json");
}
function haltPath(opsDir: string): string {
  return path.join(opsDir, "distill-halt.json");
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readLedger(opsDir: string, base: string): Ledger | null {
  const v = readJson(ledgerPath(opsDir, base)) as Partial<Ledger> | null;
  if (!v || typeof v.attempt !== "number" || typeof v.not_before !== "number") return null;
  return { attempt: v.attempt, last_error: String(v.last_error ?? ""), last_at: Number(v.last_at ?? 0), not_before: v.not_before };
}

/** The halt record, or null when the drain is not halted. */
export function readDistillHalt(opsDir: string): DrainHalt | null {
  const v = readJson(haltPath(opsDir)) as Partial<DrainHalt> | null;
  if (!v || typeof v.reason !== "string") return null;
  return { reason: v.reason, at: Number(v.at ?? 0), consecutive: Number(v.consecutive ?? 0), job_ids: Array.isArray(v.job_ids) ? v.job_ids.map(String) : [] };
}

/** Manual reset (no UI): clears the halt and the failure streak. Parked jobs and
 *  ledgers are left exactly as they are. */
export function resetDistillHalt(opsDir: string): void {
  fs.rmSync(haltPath(opsDir), { force: true });
  fs.rmSync(streakPath(opsDir), { force: true });
}

interface Candidate {
  file: string;
  base: string;
  /** Attempts already made: 0 for a ready job, the ledger's count (1 when the
   *  ledger is absent = legacy `.failed-<ms>`) for a set-aside one. */
  prior: number;
}

/** Everything the drain may offer right now: ready jobs plus set-aside jobs whose
 *  backoff has passed (legacy `.failed-` files are always due). Parked jobs and
 *  ledgers are never candidates. Sorted by base name = enqueue order. */
function candidates(opsDir: string, now: number, skip?: Set<string>): Candidate[] {
  let names: string[];
  try {
    names = fs.readdirSync(queueDir(opsDir));
  } catch {
    return [];
  }
  return names
    .flatMap((name): Candidate[] => {
      const m = STATE_NAME.exec(name);
      if (!m || skip?.has(m[1])) return [];
      const file = path.join(queueDir(opsDir), name);
      if (!m[2]) return [{ file, base: m[1], prior: readLedger(opsDir, m[1])?.attempt ?? 0 }];
      if (m[2] === "parked") return [];
      const ledger = readLedger(opsDir, m[1]);
      if (ledger && ledger.not_before > now) return [];
      return [{ file, base: m[1], prior: ledger?.attempt ?? 1 }];
    })
    .sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0));
}

/** Is there anything a drain loop could still offer? (Ready jobs and due retries;
 *  a backing-off or parked job is NOT work.) */
export function hasOfferableWork(opsDir: string, now: number, skip?: Set<string>): boolean {
  return candidates(opsDir, now, skip).length > 0;
}

/** One pass over every offerable job, in order. A job file is removed only after
 *  its handler resolves. A failure records attempt / error / time in the ledger and
 *  sets the file aside (backing off) — or parks it on the 4th failed attempt.
 *  Stops, leaving every remaining job untouched, once 5 DIFFERENT jobs have failed
 *  consecutively; refuses to start at all while a halt is on record. */
export async function drainPass(
  opsDir: string,
  handler: (job: DistillJob) => Promise<void>,
  opts: DrainOpts = {},
): Promise<DrainResult> {
  const now = opts.now ?? Date.now;
  const result: DrainResult = { attempted: 0, succeeded: 0, failed: 0, parked: 0 };
  const standing = readDistillHalt(opsDir);
  if (standing) return { ...result, halted: standing };

  for (const c of candidates(opsDir, now(), opts.attempted)) {
    opts.attempted?.add(c.base);
    result.attempted++;
    let failure: unknown;
    let handlerRan = false;
    try {
      const job: DistillJob = JSON.parse(fs.readFileSync(c.file, "utf8"));
      handlerRan = true;
      await handler(job);
    } catch (err) {
      failure = err ?? new Error("unknown failure");
    }
    if (failure === undefined) {
      fs.unlinkSync(c.file);
      fs.rmSync(ledgerPath(opsDir, c.base), { force: true });
      fs.rmSync(streakPath(opsDir), { force: true });
      result.succeeded++;
      continue;
    }
    result.failed++;
    const at = now();
    const attempt = c.prior + 1;
    const parks = attempt >= MAX_ATTEMPTS;
    if (parks) result.parked++;
    try {
      // ledger first: a crash between the two leaves a ready job with an
      // over-counted ledger (parks sooner), never an uncounted failure.
      fs.mkdirSync(queueDir(opsDir), { recursive: true });
      fs.writeFileSync(
        ledgerPath(opsDir, c.base),
        JSON.stringify({
          attempt,
          last_error: (failure instanceof Error ? failure.message : String(failure)).slice(0, MAX_ERROR_CHARS),
          last_at: at,
          not_before: parks ? 0 : at + RETRY_BACKOFF_MS[attempt - 1],
        }) + "\n",
      );
      fs.renameSync(c.file, path.join(queueDir(opsDir), `${c.base}.${parks ? "parked" : "failed"}-${at}`));
    } catch {
      /* leave it; the attempted set keeps this loop from re-offering it */
    }
    // An unparseable file never reached the handler: it is no evidence of a systemic fault.
    if (!handlerRan) continue;
    const ids = (readJson(streakPath(opsDir)) as { job_ids?: string[] } | null)?.job_ids ?? [];
    if (!ids.includes(c.base)) ids.push(c.base);
    fs.writeFileSync(streakPath(opsDir), JSON.stringify({ job_ids: ids }) + "\n");
    if (ids.length >= HALT_AFTER) {
      const halt: DrainHalt = {
        reason: `distill drain halted: ${ids.length} consecutive failures across different jobs (last: ${c.base}) — reset with resetDistillHalt after fixing the cause`,
        at,
        consecutive: ids.length,
        job_ids: ids,
      };
      fs.writeFileSync(haltPath(opsDir), JSON.stringify(halt, null, 2) + "\n");
      return { ...result, halted: halt };
    }
  }
  return result;
}

/** Back-compat wrapper: one pass, returns the number of jobs that succeeded. */
export async function drainOnce(
  opsDir: string,
  handler: (job: DistillJob) => Promise<void>,
  opts: DrainOpts = {},
): Promise<number> {
  return (await drainPass(opsDir, handler, opts)).succeeded;
}

/** The distiller spawn transport (spec §4 config transport, plan reviewer #5):
 *  `distiller.config.json` — written by the extension at activation, read by
 *  every spawner (extension trigger, plugin trigger-4, batch shell) so all
 *  three produce identical distiller processes. */
export interface DistillerConfigFile {
  /** Absolute path of the opencode binary to spawn. */
  binary: string;
  /** The OPENCODE_CONFIG_CONTENT object for the distiller variant. */
  config: Record<string, unknown>;
  /** Merged into every job by spawners that don't know the paths themselves
   *  (the Bun plugin, the batch shell): vault, ops, runs_root. */
  job_defaults?: Record<string, unknown>;
}

export function distillerConfigPath(opsDir: string): string {
  return path.join(opsDir, "distiller.config.json");
}

export function readDistillerConfig(opsDir: string): DistillerConfigFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(distillerConfigPath(opsDir), "utf8"));
    if (typeof parsed.binary === "string" && parsed.config) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function writeDistillerConfig(opsDir: string, file: DistillerConfigFile): void {
  fs.mkdirSync(opsDir, { recursive: true });
  fs.writeFileSync(distillerConfigPath(opsDir), JSON.stringify(file, null, 2) + "\n");
}

/** Run ONE distill job as a headless opencode child (`run --agent distiller`),
 *  awaited — the drain loop is deterministic code; only the job itself is LLM. */
export function runDistillerJob(
  cfg: DistillerConfigFile,
  job: DistillJob,
  timeoutMs: number = JOB_TIMEOUT_MS,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cfg.binary,
      ["run", "--agent", "distiller", JSON.stringify(job)],
      {
        env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg.config) },
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`.trim();
        if (err && (err as { code?: unknown }).code !== 0) {
          reject(new Error(`distiller job failed (${(err as { code?: unknown }).code}): ${output.slice(-500)}`));
        } else {
          resolve({ code: 0, output });
        }
      },
    );
  });
}

/** Convenience used by every trigger: enqueue, then drain the queue through
 *  headless distiller children. No-ops (returns false) when the transport
 *  config hasn't been written yet — the job stays queued for the next drain. */
export async function enqueueAndDrain(opsDir: string, job: DistillJob, clock: DrainClock): Promise<boolean> {
  enqueueJob(opsDir, job);
  const cfg = readDistillerConfig(opsDir);
  if (!cfg) return false;
  return runDrainLoop(opsDir, makeDistillHandler(cfg), clock);
}

/** The drain handler used by every trigger: resolve the job's machine paths
 *  against THIS machine's config (`rebaseJob`), then spawn the distiller.
 *  A job that cannot be resolved throws before anything is spawned. `spawn` and
 *  `env` are test seams (no mocks: a recording closure and an injected `exists`). */
export function makeDistillHandler(
  cfg: DistillerConfigFile,
  spawn: (cfg: DistillerConfigFile, job: DistillJob) => Promise<unknown> = runDistillerJob,
  env: RebaseEnv = defaultRebaseEnv(),
): (job: DistillJob) => Promise<void> {
  return async (job) => {
    await spawn(cfg, rebaseJob(job, cfg.job_defaults, env));
  };
}

export interface RebaseEnv {
  exists: (p: string) => boolean;
}

export function defaultRebaseEnv(): RebaseEnv {
  return { exists: fs.existsSync };
}

/** The fields a job records from the enqueueing machine, each resolved from the
 *  drain config's `job_defaults` when the recorded path is not usable here. */
const REBASED_FIELDS = ["vault", "ops", "runs_root"] as const;

/** Resolve a queued job's machine-shaped paths for THIS machine (#2097).
 *
 *  - A recorded vault/ops/runs_root that does not exist here is replaced by
 *    `defaults[field]`; the originals are kept on the copy as `rebased_from`.
 *    No default → throws naming the field (never guessed). Existence is the ONLY
 *    test: an existing path is trusted wherever it lives (another volume, a
 *    mount outside $HOME), since rebasing it onto `job_defaults` could point the
 *    distiller at a different vault.
 *  - Fields the job does not carry are not invented; identity fields (kind,
 *    run_id, session_ids, …) are never touched.
 *  - `demo_dir` has no configured counterpart to rebase onto: it is left alone if
 *    it exists, otherwise the job fails naming `demo_dir`.
 *  - A run job whose `<runs_root>/<run_id>` is missing fails naming that directory.
 *  - A job needing no change is returned as-is (same object, byte-identical). */
export function rebaseJob(
  job: DistillJob,
  defaults: Record<string, unknown> | undefined,
  env: RebaseEnv,
): DistillJob {
  const usable = (p: unknown) => typeof p === "string" && env.exists(p);

  const rebased: Record<string, unknown> = {};
  const from: Record<string, unknown> = {};
  for (const field of REBASED_FIELDS) {
    if (!(field in job) || usable(job[field])) continue;
    const value = defaults?.[field];
    if (typeof value !== "string" || value === "") {
      throw new Error(
        `distill job cannot be rebased: ${field} (${JSON.stringify(job[field])}) is not usable on this machine ` +
          `and the drain config has no job_defaults.${field}`,
      );
    }
    if (value === job[field]) continue;
    from[field] = job[field];
    rebased[field] = value;
  }

  const out: DistillJob = Object.keys(from).length ? { ...job, ...rebased, rebased_from: from } : job;

  if (typeof out.demo_dir === "string" && !env.exists(out.demo_dir)) {
    throw new Error(`distill job cannot run: demo_dir ${out.demo_dir} does not exist on this machine`);
  }
  if (out.kind === "run" && typeof out.run_id === "string" && typeof out.runs_root === "string") {
    const runDir = path.join(out.runs_root, out.run_id);
    if (!env.exists(runDir)) throw new Error(`distill job cannot run: run directory ${runDir} does not exist`);
  }
  return out;
}

export function defaultClock(): DrainClock {
  return {
    pid: process.pid,
    now: () => Date.now(),
    isPidAlive: (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export interface DrainLoopResult {
  /** True when this caller won the lock and drained; false when it lost the claim. */
  ran: boolean;
  /** Set when the drain is halted (now or by an earlier drain). */
  halted?: DrainHalt;
}

/** Full winner protocol: claim (or reclaim stale) → drain → release →
 *  post-release re-check → re-claim if jobs landed during the handoff.
 *  Returns `ran: false` immediately if we lost the claim (a holder will drain).
 *  Terminates: every pass only offers jobs not yet attempted in this loop, and a
 *  backing-off / parked job is not "work", so nothing can spin. */
export async function runDrainLoopResult(
  opsDir: string,
  handler: (job: DistillJob) => Promise<void>,
  clock: DrainClock,
): Promise<DrainLoopResult> {
  if (
    !claimLock(opsDir, clock.pid) &&
    !reclaimIfStale(opsDir, clock.pid, { now: clock.now(), isPidAlive: clock.isPidAlive })
  ) {
    return { ran: false };
  }
  // We hold the lock.
  const attempted = new Set<string>();
  for (;;) {
    let halted: DrainHalt | undefined;
    while (hasOfferableWork(opsDir, clock.now(), attempted)) {
      const pass = await drainPass(opsDir, handler, { now: clock.now, attempted });
      halted = pass.halted;
      if (halted || pass.attempted === 0) break;
    }
    releaseLock(opsDir);
    if (halted ??= readDistillHalt(opsDir) ?? undefined) return { ran: true, halted };
    if (!hasOfferableWork(opsDir, clock.now(), attempted)) return { ran: true }; // post-release re-check: truly done
    if (!claimLock(opsDir, clock.pid)) return { ran: true }; // a new holder owns the late jobs
  }
}

export async function runDrainLoop(
  opsDir: string,
  handler: (job: DistillJob) => Promise<void>,
  clock: DrainClock,
): Promise<boolean> {
  return (await runDrainLoopResult(opsDir, handler, clock)).ran;
}
