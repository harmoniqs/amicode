// run.lock — the liveness record of one run (#2045 A; contract shared with A2 #2055).
//
// One JSON file per run dir, written atomically by the ORCHESTRATOR process (the one that
// owns the Julia child and writes FINISHED), refreshed by a heartbeat. A reader that finds
// a lock without FINISHED, `ended !== true` and a heartbeat older than LOCK_STALE_MS knows
// the orchestrator died: the run is DEAD, not merely quiet. No lock ⇒ legacy behaviour.
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export const LOCK_FILE = "run.lock";
/** Heartbeat interval (the orchestrator refreshes `heartbeat_at` this often). */
export const LOCK_HEARTBEAT_MS = 30_000;
/** Three missed beats: a lock older than this, unfinished and not ended, is dead. */
export const LOCK_STALE_MS = 90_000;

export interface RunLock {
  schema: 1;
  run_id: string;
  /** systemd unit name, or null when the run could not be placed in a unit */
  unit: string | null;
  /** the ORCHESTRATOR pid (owns the Julia child, writes FINISHED) — not Julia's */
  pid: number;
  host: string;
  /** sha256 of the canonical solvespec, or null for bare runs */
  spec_hash: string | null;
  protection: "unit" | "none";
  cloud_run_id: string | null;
  started_at: string;
  heartbeat_at: string;
  ended: boolean;
}

export function writeRunLock(runDir: string, lock: RunLock): void {
  const tmp = join(runDir, `.${LOCK_FILE}.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(lock, null, 2) + "\n", { mode: 0o644 });
  renameSync(tmp, join(runDir, LOCK_FILE));
}

export function readRunLock(runDir: string): RunLock | undefined {
  try {
    const v = JSON.parse(readFileSync(join(runDir, LOCK_FILE), "utf8")) as Partial<RunLock>;
    if (v?.schema !== 1 || typeof v.run_id !== "string" || typeof v.heartbeat_at !== "string") return undefined;
    return v as RunLock;
  } catch {
    return undefined;
  }
}

/** The contract's liveness rule: DEAD iff a lock exists, FINISHED does not, `ended` is not
 *  true, and the heartbeat is older than LOCK_STALE_MS. */
export function lockIsDead(runDir: string, lock: RunLock, now = Date.now(), staleMs = LOCK_STALE_MS): boolean {
  if (existsSync(join(runDir, "FINISHED"))) return false;
  if (lock.ended === true) return false;
  const beat = Date.parse(lock.heartbeat_at);
  return Number.isNaN(beat) || now - beat > staleMs;
}

/** A lock that currently claims a live run: not ended, no FINISHED, fresh heartbeat. */
export function lockIsLive(runDir: string, lock: RunLock, now = Date.now()): boolean {
  if (existsSync(join(runDir, "FINISHED"))) return false;
  if (lock.ended === true) return false;
  const beat = Date.parse(lock.heartbeat_at);
  return !Number.isNaN(beat) && now - beat <= LOCK_STALE_MS;
}

export interface LockHeartbeat {
  /** Stop beating and write the final `ended: true` lock (call immediately before FINISHED). */
  end(): void;
}

/** Write the initial lock and keep it fresh. The timer is unref'd: it must never be the
 *  thing that keeps an orchestrator alive. Write failures are reported once and never fail
 *  the run — a lost heartbeat degrades to the legacy stall heuristics, a crash would not. */
export function startRunLock(
  runDir: string,
  init: { runId: string; unit: string | null; protection: "unit" | "none"; specHash: string | null; cloudRunId?: string | null },
  intervalMs = LOCK_HEARTBEAT_MS,
): LockHeartbeat {
  const now = (): string => new Date().toISOString();
  const lock: RunLock = {
    schema: 1,
    run_id: init.runId,
    unit: init.unit,
    pid: process.pid,
    host: hostname(),
    spec_hash: init.specHash,
    protection: init.protection,
    cloud_run_id: init.cloudRunId ?? null,
    started_at: now(),
    heartbeat_at: now(),
    ended: false,
  };
  let warned = false;
  const write = (): void => {
    try {
      writeRunLock(runDir, lock);
    } catch (e) {
      if (warned) return;
      warned = true;
      process.stderr.write(`amico-run: cannot write ${LOCK_FILE}: ${(e as Error).message}\n`);
    }
  };
  write();
  const timer = setInterval(() => {
    lock.heartbeat_at = now();
    write();
  }, intervalMs);
  timer.unref();
  return {
    end() {
      clearInterval(timer);
      lock.heartbeat_at = now();
      lock.ended = true;
      write();
    },
  };
}

/** A run in `runsRoot` that currently claims the live run of this exact spec (#2045 G), or
 *  undefined. A run counts as live when it has a live lock (see lockIsLive) with the same
 *  `spec_hash`, or when it is prepared but its orchestrator has not written a lock yet and the
 *  run dir is younger than the stale window (the gap between `prepareRun` and adopt start-up).
 *  Dead, ended and finished runs never block: deliberate re-runs are allowed. */
export function findLiveDuplicate(
  runsRoot: string,
  specHash: string,
  now = Date.now(),
  staleMs = LOCK_STALE_MS,
): { runId: string; pid?: number; startedAt?: string } | undefined {
  let entries: string[];
  try {
    entries = readdirSync(runsRoot);
  } catch {
    return undefined;
  }
  for (const id of entries) {
    if (id.startsWith(".")) continue;
    const dir = join(runsRoot, id);
    if (existsSync(join(dir, "FINISHED"))) continue;
    const lock = readRunLock(dir);
    if (lock) {
      if (lock.spec_hash === specHash && lock.ended !== true) {
        const beat = Date.parse(lock.heartbeat_at);
        if (!Number.isNaN(beat) && now - beat <= staleMs) return { runId: id, pid: lock.pid, startedAt: lock.started_at };
      }
      continue;
    }
    // prepared, orchestrator not up yet
    try {
      const manifest = readFileSync(join(dir, "run.toml"), "utf8");
      const hash = /^spec_hash = "([^"]*)"/m.exec(manifest)?.[1];
      const created = /^created_at = "([^"]*)"/m.exec(manifest)?.[1];
      if (hash === specHash && created && now - Date.parse(created) <= staleMs) return { runId: id, startedAt: created };
    } catch {
      /* not a run dir */
    }
  }
  return undefined;
}
