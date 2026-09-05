// sota_fetch.test.ts — the ONE-FETCHER property (#820, spec D4 / S6): all
// live arXiv traffic rides the FETCH cache plus the fleet-wide serialized
// queue. The flow under the lock RE-CHECKS the cache before fetching — a
// second fetcher that waited on the lock reads the first one's cache and
// NEVER refetches; a fetcher that cannot get the lock falls through to the
// NAMED queue-timeout outcome. The recipe gotcha is mechanical: http:// is
// refused (the arXiv export API's http endpoint silently hangs — always
// https).
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchThroughQueue, FETCH_CACHE_TTL_MS, cachePath, sourceKeyOf, type SotaFetch } from "../src/sota_fetch.js";
import { QUEUE_LOCK_NAME, QUEUE_POLL_INTERVAL_MS, acquireQueueLock } from "../src/sota_queue.js";

function root(): string {
  return mkdtempSync(join(tmpdir(), "sota-fetch-"));
}

function vclock(start = 1_000_000) {
  let t = start;
  return {
    nowMs: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    jump: (ms: number) => {
      t += ms;
    },
  };
}

const okFetch = (body: string, count: number): SotaFetch & { calls: string[] } => {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    return { ok: true as const, status: 200, body, count };
  }) as SotaFetch;
  return Object.assign(fn, { calls }) as SotaFetch & { calls: string[] };
};

describe("fetchThroughQueue — the one-fetcher flow (S6)", () => {
  it("cache miss → acquires the lock (the fetch runs UNDER the lock) → fetches once → writes the cache", async () => {
    const r = root();
    const c = vclock();
    const fetch = okFetch("<payload/>", 3);
    let lockHeldDuringFetch = false;
    const res = await fetchThroughQueue("https://export.arxiv.org/api/query?search_query=all:test", {
      root: r,
      fetchFn: (async (url: string) => {
        lockHeldDuringFetch = existsSync(join(r, QUEUE_LOCK_NAME));
        return fetch(url);
      }) as SotaFetch,
      nowMs: c.nowMs,
      sleep: c.sleep,
    });
    expect(res.via).toBe("fetched");
    expect(fetch.calls).toHaveLength(1);
    expect(lockHeldDuringFetch).toBe(true); // the queue is real, not decorative
    expect(existsSync(cachePath(r, "https://export.arxiv.org/api/query?search_query=all:test"))).toBe(true);
  });

  it("a SECOND fetcher reads the cache — the transport is called exactly once (never refetch what a cache holds)", async () => {
    const r = root();
    const c = vclock();
    const url = "https://export.arxiv.org/api/query?search_query=all:test";
    const a = await fetchThroughQueue(url, { root: r, fetchFn: okFetch("<payload/>", 3), nowMs: c.nowMs, sleep: c.sleep });
    expect(a.via).toBe("fetched");
    const b = await fetchThroughQueue(url, { root: r, fetchFn: okFetch("<payload/>", 3), nowMs: c.nowMs, sleep: c.sleep });
    expect(b.via).toBe("cache"); // the S6 property, by name
  });

  it("concurrent-simulation: a fetcher that WAITED on the lock RE-CHECKS the cache under the lock and reads it — no second fetch", async () => {
    const r = root();
    const c = vclock();
    const url = "https://export.arxiv.org/api/query?search_query=all:race";
    const slow = (async (u: string) => {
      await c.sleep(QUEUE_POLL_INTERVAL_MS); // A's fetch is slow — B waits on the lock
      return { ok: true as const, status: 200, body: "<a/>", count: 2 };
    }) as SotaFetch;
    const aPromise = fetchThroughQueue(url, { root: r, fetchFn: slow, nowMs: c.nowMs, sleep: c.sleep });
    const calls: string[] = [];
    const bPromise = fetchThroughQueue(url, {
      root: r,
      fetchFn: ((async (u: string) => {
        calls.push(u);
        return { ok: true as const, status: 200, body: "<b/>", count: 2 };
      }) as SotaFetch),
      nowMs: c.nowMs,
      sleep: c.sleep,
    });
    const [a, b] = await Promise.all([aPromise, bPromise]);
    expect(a.via).toBe("fetched");
    expect(b.via).toBe("cache"); // B waited, then read A's cache — ONE transport call for the fleet
    expect(calls).toHaveLength(0); // B's transport was never invoked
  });

  it("a lock held past the bounded wait → the NAMED queue-timeout outcome, transport untouched, the cache-read fallback disclosed", async () => {
    const r = root();
    const c = vclock();
    // a foreign lease far in the future — nothing will release it
    await acquireQueueLock(r, { nowMs: c.nowMs, sleep: c.sleep, leaseTtlMs: 60_000_000 });
    const calls: string[] = [];
    const res = await fetchThroughQueue("https://export.arxiv.org/api/query?search_query=all:busy", {
      root: r,
      fetchFn: ((async (u: string) => {
        calls.push(u);
        return { ok: true as const, status: 200, body: "", count: 0 };
      }) as SotaFetch),
      nowMs: c.nowMs,
      sleep: c.sleep,
      waitTimeoutMs: 500,
    });
    expect(res.via).toBe("queue-timeout");
    if (res.via === "queue-timeout") expect(res.detail).toMatch(/cache|waiver/i);
    expect(calls).toHaveLength(0);
  });

  it("http:// is REFUSED — the arXiv export API's http endpoint silently hangs; always https (the recipe gotcha, mechanical)", async () => {
    const r = root();
    const c = vclock();
    const calls: string[] = [];
    const res = await fetchThroughQueue("http://export.arxiv.org/api/query?id_list=1", {
      root: r,
      fetchFn: ((async (u: string) => {
        calls.push(u);
        return { ok: true as const, status: 200, body: "", count: 0 };
      }) as SotaFetch),
      nowMs: c.nowMs,
      sleep: c.sleep,
    });
    expect(res.via).toBe("refused");
    if (res.via === "refused") {
      expect(res.reason).toMatch(/https/i);
      expect(res.reason).toMatch(/hang/i); // the gotcha is named, not just "bad scheme"
    }
    expect(calls).toHaveLength(0);
  });

  it("a STALE cache (older than the TTL) refetches — the daily digest's cadence is never starved by the cache", async () => {
    const r = root();
    const c = vclock();
    const url = "https://export.arxiv.org/api/query?search_query=all:stale";
    const first = await fetchThroughQueue(url, { root: r, fetchFn: okFetch("<v1/>", 1), nowMs: c.nowMs, sleep: c.sleep });
    expect(first.via).toBe("fetched");
    c.jump(FETCH_CACHE_TTL_MS + 1);
    const second = await fetchThroughQueue(url, { root: r, fetchFn: okFetch("<v2/>", 2), nowMs: c.nowMs, sleep: c.sleep });
    expect(second.via).toBe("fetched"); // stale → not a hit; the cache never serves day-old data as fresh
  });

  it("a transport FAILURE is a named outcome (never a silent empty) and does NOT write the cache", async () => {
    const r = root();
    const c = vclock();
    const fail = (async () => ({ ok: false as const, status: 0, error: "curl: (28) timed out" })) as SotaFetch;
    const res = await fetchThroughQueue("https://export.arxiv.org/api/query?search_query=all:down", {
      root: r,
      fetchFn: fail,
      nowMs: c.nowMs,
      sleep: c.sleep,
    });
    expect(res.via).toBe("fetch-failed");
    if (res.via === "fetch-failed") expect(res.error).toMatch(/timed out/);
    expect(existsSync(cachePath(r, "https://export.arxiv.org/api/query?search_query=all:down"))).toBe(false);
  });

  it("every ok fetch records its source's history (the anomaly floor's input, recorded by construction)", async () => {
    const r = root();
    const c = vclock();
    const url = "https://export.arxiv.org/api/query?search_query=all:hist";
    await fetchThroughQueue(url, { root: r, fetchFn: okFetch("<x/>", 4), nowMs: c.nowMs, sleep: c.sleep });
    const { readFetchHistory } = await import("../src/sota_history.js");
    expect(readFetchHistory(r, sourceKeyOf(url))).toEqual([{ date: new Date(c.nowMs()).toISOString().slice(0, 10), count: 4 }]);
  });
});

describe("the fetch cache (the digest's FETCH cache — a shared referent, never the briefs)", () => {
  it("the cache TTL is named and bounded: hours, not days — the daily cadence refetches, the fleet does not", () => {
    expect(FETCH_CACHE_TTL_MS).toBeGreaterThanOrEqual(60 * 60_000); // ≥ 1h: the fleet dedupes within a window
    expect(FETCH_CACHE_TTL_MS).toBeLessThan(24 * 60 * 60_000); // < 24h: a daily digest always refetches
  });
});
