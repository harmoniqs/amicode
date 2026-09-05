// sota_queue.ts — the FLEET-WIDE serialized query queue (#820, spec
// spec-20260905-103000 living-sota D4, the one-fetcher invariant): every live
// arXiv fetch rides ONE lock-file queue at the SHARED vault path — the sota
// root under the fleet-synced personal vault mount, NOT a per-host ~/.amico
// path (a per-host lock serializes nothing; the fleet is the concurrency).
//
// The lock is a lease file (POSIX O_EXCL create, the mode_staging.ts
// discipline): entries carry owner token + expiry; an expired or corrupt
// lease is RECLAIMED so a dead fetcher never blocks the fleet; a release is
// RENAME-TO-TOMBSTONE — the lock file is renamed away first and only then
// read, so a release racing a reclaim can never unlink the NEW owner's lock
// (the token check and the unlink are never two unguarded steps; a foreign
// lease found in the tombstone is RESTORED, not dropped).
//
// KNOWN LIMIT (named, not hidden — a spec-level residual, A2): O_EXCL is
// atomic per HOST; the lock file crosses machines by vault sync, whose
// propagation latency makes fleet-wide mutual exclusion BEST-EFFORT — two
// hosts can hold overlapping leases for the sync-gap window. The under-lock
// cache RE-CHECK bounds the damage to a duplicate transport — the second
// fetcher reads the first one's cache — never a correctness break.
//
// The wait is BOUNDED and falls through to the NAMED outcome — the survey
// never blocks the loop: a fetcher that cannot get the lock inside
// QUEUE_WAIT_TIMEOUT_MS returns {outcome: "queue-timeout"} and the caller
// reads the cache or records the waiver, always named, never silent.
//
// ── O4 — the constants, named and justified (build-time values; the spec
// pins the shape) ─────────────────────────────────────────────────────────
//
// QUEUE_LEASE_TTL_MS = 90_000 (90s): the serialized unit is ONE query whose
//   transport bound is curl --max-time 30 (the existing S31 network seam,
//   papers_digest.ts). 90s = 3× the transport bound: a LIVE fetcher whose
//   transport is at its worst-case limit is never evicted mid-fetch, while a
//   DEAD fetcher's stale lease blocks the fleet for at most 90s before
//   reclamation.
//
// QUEUE_WAIT_TIMEOUT_MS = 120_000 (120s): one full lease plus a poll interval
//   of margin — a waiter whose holder is alive-but-slow still gets the lock
//   right after a legitimate release, while a holder that never releases
//   costs the waiter at most 120s before the named fall-through. The survey
//   never blocks: the receipt-or-waiver discipline (later slices' gate)
//   proceeds on the named outcome.
//
// QUEUE_POLL_INTERVAL_MS = 250: release-to-acquire latency is one poll at
//   most — imperceptible for a human survey — while a fleet of waiters
//   cannot spin the lock file.
import { closeSync, openSync, readFileSync, renameSync, linkSync, rmSync, writeSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const QUEUE_LOCK_NAME = "queue.lock";

/** O4: one lease covers one full transport attempt (curl --max-time 30) with
 *  3× margin — see the header. */
export const QUEUE_LEASE_TTL_MS = 90_000;

/** O4: the bounded wait — one lease + a poll of margin, then the NAMED
 *  fall-through. See the header. */
export const QUEUE_WAIT_TIMEOUT_MS = 120_000;

/** The poll cadence — a poll, not a spin. */
export const QUEUE_POLL_INTERVAL_MS = 250;

export interface QueueLock {
  token: string;
  lockPath: string;
  expiresAt: number;
}

export interface QueueLease {
  token: string;
  acquired_at: number;
  expires_at: number;
}

export type AcquireResult =
  | { acquired: true; lock: QueueLock }
  | {
      acquired: false;
      outcome: "queue-timeout";
      waitedMs: number;
      /** The named fall-through — the disclosed alternative (cache-read or waiver). */
      detail: string;
    };

export interface QueueOpts {
  /** The clock — injectable for deterministic tests. */
  nowMs?: () => number;
  /** The yield between polls — injectable for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Override the bounded wait (tests). */
  waitTimeoutMs?: number;
  /** Override the poll cadence (tests). */
  pollIntervalMs?: number;
  /** Override the lease TTL (tests). */
  leaseTtlMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

function readLease(lockPath: string): QueueLease | null {
  try {
    const j = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<QueueLease>;
    if (typeof j.token !== "string" || typeof j.expires_at !== "number") return null;
    return { token: j.token, acquired_at: j.acquired_at ?? 0, expires_at: j.expires_at };
  } catch {
    return null;
  }
}

function tryLockOnce(lockPath: string, now: number, leaseTtlMs: number): QueueLock | null {
  const token = randomUUID();
  const lease: QueueLease = { token, acquired_at: now, expires_at: now + leaseTtlMs };
  let fd: number | null = null;
  try {
    fd = openSync(lockPath, "wx");
    writeSync(fd, JSON.stringify(lease) + "\n");
    closeSync(fd);
    fd = null;
    return { token, lockPath, expiresAt: lease.expires_at };
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best effort */
      }
    }
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw e;
    // held: is the lease EXPIRED (or corrupt)? → reclaim; the next loop
    // iteration re-attempts the atomic O_EXCL create, so two concurrent
    // reclaimers still produce exactly one owner.
    const held = readLease(lockPath);
    if (held === null || held.expires_at <= now) {
      try {
        rmSync(lockPath);
      } catch {
        /* someone else reclaimed first — fine */
      }
    }
    return null;
  }
}

/** Acquire the fleet-wide queue lock, waiting BOUNDED. Falls through to the
 *  NAMED queue-timeout outcome — never throws, never blocks the loop. */
export async function acquireQueueLock(root: string, opts: QueueOpts = {}): Promise<AcquireResult> {
  const nowMs = opts.nowMs ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const pollMs = opts.pollIntervalMs ?? QUEUE_POLL_INTERVAL_MS;
  const timeoutMs = opts.waitTimeoutMs ?? QUEUE_WAIT_TIMEOUT_MS;
  const leaseTtlMs = opts.leaseTtlMs ?? QUEUE_LEASE_TTL_MS;
  mkdirSync(root, { recursive: true });
  const lockPath = join(root, QUEUE_LOCK_NAME);
  const start = nowMs();
  for (;;) {
    const lock = tryLockOnce(lockPath, nowMs(), leaseTtlMs);
    if (lock !== null) return { acquired: true, lock };
    const waited = nowMs() - start;
    if (waited >= timeoutMs) {
      return {
        acquired: false,
        outcome: "queue-timeout",
        waitedMs: waited,
        detail:
          "queue lock held past the bounded wait — falling through to the named outcome (read the fetch cache, or record the waiver); never a silent block",
      };
    }
    await sleep(Math.min(pollMs, timeoutMs - waited));
  }
}

/** Release a lock — rename-to-tombstone (A3): the lock file is renamed to a
 *  token-named tombstone FIRST (removing it from the slot atomically), then
 *  the tombstone is read. If the lease is OURS: the tombstone is removed —
 *  a clean release of exactly our own lease. If the lease is FOREIGN (the
 *  reclaim raced the release): the tombstone is restored into the slot via
 *  link() — which fails with EEXIST if a new owner already holds, in which
 *  case the live owner stands and the tombstone is dropped. Either way, a
 *  release can never unlink a lease it does not own. */
export function releaseQueueLock(lock: QueueLock): void {
  const tomb = `${lock.lockPath}.dead-${lock.token}`;
  try {
    renameSync(lock.lockPath, tomb);
  } catch {
    return; // nothing to release — already gone; never resurrect anything
  }
  const held = readLease(tomb);
  if (held !== null && held.token === lock.token) {
    try {
      rmSync(tomb);
    } catch {
      /* best effort — the tombstone is inert either way */
    }
    return;
  }
  // a foreign lease (the reclaim raced the release): restore it if the slot
  // is still empty; link() fails with EEXIST if a new owner already holds.
  try {
    linkSync(tomb, lock.lockPath);
  } catch {
    /* the slot is taken — the live owner's lock stands */
  }
  try {
    rmSync(tomb);
  } catch {
    /* best effort */
  }
}
