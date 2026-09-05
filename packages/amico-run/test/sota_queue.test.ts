// sota_queue.test.ts — the FLEET-WIDE serialized query queue (#820, spec
// spec-20260905-103000 D4 / one-fetcher invariant / S6): every live arXiv
// fetch rides ONE lock-file queue at the SHARED vault path — a per-host lock
// serializes nothing, so the lock lives in the fleet-synced sota root, not in
// ~/.amico. Entries carry a TTL lease reclaimed on expiry; waits are BOUNDED
// by a named timeout that falls through to the NAMED outcome (the survey
// never blocks the loop). O4's constants are pinned here as assertions.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireQueueLock,
  releaseQueueLock,
  QUEUE_LOCK_NAME,
  QUEUE_LEASE_TTL_MS,
  QUEUE_WAIT_TIMEOUT_MS,
  QUEUE_POLL_INTERVAL_MS,
  type QueueLock,
} from "../src/sota_queue.js";

function root(): string {
  return mkdtempSync(join(tmpdir(), "sota-queue-"));
}

/** A virtual clock: `nowMs()` reads it, `sleep` advances it — the whole wait
 *  loop runs in zero wall time, fully deterministic. */
function vclock(start = 1_000_000) {
  let t = start;
  return {
    nowMs: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    peek: () => t,
    jump: (ms: number) => {
      t += ms;
    },
  };
}

function lockPath(r: string): string {
  return join(r, QUEUE_LOCK_NAME);
}

describe("the fleet-wide queue lock (D4 — one serialized query queue)", () => {
  it("acquire creates the lock file with a TTL lease; release removes it", async () => {
    const r = root();
    const c = vclock();
    const res = await acquireQueueLock(r, { nowMs: c.nowMs, sleep: c.sleep });
    expect(res.acquired).toBe(true);
    if (!res.acquired) return;
    expect(existsSync(lockPath(r))).toBe(true);
    const lease = JSON.parse(readFileSync(lockPath(r), "utf8"));
    expect(lease.token).toBe(res.lock.token);
    expect(lease.expires_at).toBe(c.peek() + QUEUE_LEASE_TTL_MS); // the TTL lease is real, not decorative
    releaseQueueLock(res.lock);
    expect(existsSync(lockPath(r))).toBe(false);
  });

  it("a second fetcher WAITS (bounded) and acquires after the holder releases", async () => {
    const r = root();
    const c = vclock();
    const a = await acquireQueueLock(r, { nowMs: c.nowMs, sleep: c.sleep });
    expect(a.acquired).toBe(true);
    let bPromise = acquireQueueLock(r, { nowMs: c.nowMs, sleep: c.sleep });
    // release A the first time B's poll yields — B must then win the O_EXCL race
    const instrumentedSleep = async (ms: number) => {
      c.sleep(ms);
      releaseQueueLock((a as { lock: QueueLock }).lock);
    };
    bPromise = acquireQueueLock(r, { nowMs: c.nowMs, sleep: instrumentedSleep });
    const b = await bPromise;
    expect(b.acquired).toBe(true);
    if (b.acquired) releaseQueueLock(b.lock);
  });

  it("an EXPIRED lease is reclaimed — a dead fetcher never blocks the fleet past its TTL", async () => {
    const r = root();
    const c = vclock(0);
    // hand-craft a stale lease whose TTL is long past
    mkdirSync(r, { recursive: true });
    writeFileSync(
      lockPath(r),
      JSON.stringify({ token: "dead-fetcher", acquired_at: 0, expires_at: QUEUE_LEASE_TTL_MS - 1 }) + "\n",
    );
    const res = await acquireQueueLock(r, { nowMs: c.nowMs, sleep: c.sleep });
    expect(res.acquired).toBe(true);
  });

  it("a CORRUPT lock file (unreadable lease) is reclaimed, not a hang", async () => {
    const r = root();
    mkdirSync(r, { recursive: true });
    writeFileSync(lockPath(r), "\x00 not json at all");
    const res = await acquireQueueLock(r, { nowMs: vclock().nowMs, sleep: vclock().sleep });
    expect(res.acquired).toBe(true);
  });

  it("the OLD owner's release never unlinks a RECLAIMED lock (token match discipline)", async () => {
    const r = root();
    const c = vclock(0);
    // A acquires, then its lease expires; B reclaims
    const a = await acquireQueueLock(r, { nowMs: c.nowMs, sleep: c.sleep });
    if (!a.acquired) throw new Error("setup: A must acquire");
    c.jump(QUEUE_LEASE_TTL_MS + 1);
    const b = await acquireQueueLock(r, { nowMs: c.nowMs, sleep: c.sleep });
    expect(b.acquired).toBe(true);
    if (!b.acquired) return;
    // A (long-dead but finally runs its release) must NOT remove B's lock
    releaseQueueLock(a.lock);
    expect(existsSync(lockPath(r))).toBe(true);
    releaseQueueLock(b.lock);
    expect(existsSync(lockPath(r))).toBe(false);
  });

  it("a held lock past the BOUNDED WAIT falls through to the NAMED outcome — never a silent block", async () => {
    const r = root();
    const c = vclock();
    const a = await acquireQueueLock(r, { nowMs: c.nowMs, sleep: c.sleep });
    expect(a.acquired).toBe(true);
    const b = await acquireQueueLock(r, {
      nowMs: c.nowMs,
      sleep: c.sleep,
      waitTimeoutMs: QUEUE_LEASE_TTL_MS, // shorter than A's lease — must time out
    });
    expect(b.acquired).toBe(false);
    if (!b.acquired) {
      expect(b.outcome).toBe("queue-timeout"); // the NAMED outcome
      expect(b.detail).toMatch(/cache|waiver/i); // the named FALLBACK is disclosed
      expect(b.waitedMs).toBeGreaterThanOrEqual(QUEUE_LEASE_TTL_MS);
    }
    if (a.acquired) releaseQueueLock(a.lock);
  });
});

describe("O4 — the queue constants, pinned (named, with reasons)", () => {
  it("the lease TTL covers a full transport attempt with margin: ≥ 3× the curl --max-time 30 transport bound", () => {
    expect(QUEUE_LEASE_TTL_MS).toBeGreaterThanOrEqual(3 * 30_000); // a live fetcher is never evicted mid-fetch
    expect(QUEUE_LEASE_TTL_MS).toBeLessThan(10 * 60_000); // a dead fetcher blocks the fleet only briefly
  });

  it("the bounded wait exceeds one lease (a released lock is acquirable) but stays under the never-block bar", () => {
    expect(QUEUE_WAIT_TIMEOUT_MS).toBeGreaterThan(QUEUE_LEASE_TTL_MS + QUEUE_POLL_INTERVAL_MS);
    expect(QUEUE_WAIT_TIMEOUT_MS).toBeLessThan(10 * 60_000);
  });

  it("the poll cadence is a poll, not a spin", () => {
    expect(QUEUE_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(100);
  });
});
