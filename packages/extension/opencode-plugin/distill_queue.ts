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
 *  - a failing job is set aside as `.failed-<ts>` (kept for inspection, not
 *    retried forever), and the drain continues */
import * as fs from "node:fs";
import * as path from "node:path";

export const STALE_LOCK_MS = 15 * 60 * 1000;

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
export function reclaimIfStale(opsDir: string, pid: number, clock: { now: number; isPidAlive: (pid: number) => boolean }): boolean {
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

/** Process every queued job in order. A job file is removed only after its
 *  handler resolves; a throwing handler sets the job aside as .failed-<ts>. */
export async function drainOnce(opsDir: string, handler: (job: DistillJob) => Promise<void>): Promise<number> {
  let n = 0;
  for (const file of listJobs(opsDir)) {
    let job: DistillJob;
    try {
      job = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      fs.renameSync(file, `${file}.failed-${Date.now()}`);
      continue;
    }
    try {
      await handler(job);
      fs.unlinkSync(file);
      n++;
    } catch {
      try {
        fs.renameSync(file, `${file}.failed-${Date.now()}`);
      } catch {
        /* leave it */
      }
    }
  }
  return n;
}

/** Full winner protocol: claim (or reclaim stale) → drain → release →
 *  post-release re-check → re-claim if jobs landed during the handoff.
 *  Returns false immediately if we lost the claim (a holder will drain). */
export async function runDrainLoop(
  opsDir: string,
  handler: (job: DistillJob) => Promise<void>,
  clock: DrainClock,
): Promise<boolean> {
  if (!claimLock(opsDir, clock.pid) && !reclaimIfStale(opsDir, clock.pid, { now: clock.now(), isPidAlive: clock.isPidAlive })) {
    return false;
  }
  // We hold the lock.
  for (;;) {
    while (!queueIsEmpty(opsDir)) {
      await drainOnce(opsDir, handler);
    }
    releaseLock(opsDir);
    if (queueIsEmpty(opsDir)) return true; // post-release re-check: truly done
    if (!claimLock(opsDir, clock.pid)) return true; // a new holder owns the late jobs
  }
}
