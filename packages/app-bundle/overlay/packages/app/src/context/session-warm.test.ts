import { describe, expect, test } from "bun:test"
import {
  BULK_WARM_MESSAGES,
  createSessionWarmScheduler,
  sessionWarmSchedulerKey,
  warmSessionServerBatches,
  warmBulkSession,
  warmOpenSessionTab,
} from "./session-warm"

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function createRequestPool(limit: number) {
  const active = new Set<string>()
  const waiters: Array<{ id: string; resolve: (release: () => void) => void }> = []
  const drain = () => {
    while (active.size < limit) {
      const next = waiters.shift()
      if (!next) return
      active.add(next.id)
      next.resolve(() => {
        active.delete(next.id)
        drain()
      })
    }
  }
  return {
    active,
    acquire(id: string) {
      return new Promise<() => void>((resolve) => {
        waiters.push({ id, resolve })
        drain()
      })
    },
  }
}

async function settle() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

describe("session warming", () => {
  test("derives safe scheduler keys for absolute, relative, malformed, and opaque server URLs", () => {
    const pageURL = "https://studio.example/app/session"
    const malformed = "http://[::1"
    const opaque = "data:text/plain,session"

    expect(
      ["https://hub.example:43117/api", "/gateway", malformed, opaque, "https://later.example/api"].map((url) =>
        sessionWarmSchedulerKey(url, pageURL),
      ),
    ).toEqual(["https://hub.example:43117", "https://studio.example", malformed, opaque, "https://later.example"])
  })

  test("caps overlapping shared-origin warm chains at three while foreground work can enter the shared six-request pool", async () => {
    const scheduler = createSessionWarmScheduler()
    const blocked = [deferred(), deferred(), deferred(), deferred()]
    const requests = createRequestPool(6)
    const started: string[] = []
    let active = 0
    let peak = 0
    const warm = (id: string, gate: ReturnType<typeof deferred>) => async () => {
      const release = await requests.acquire(id)
      started.push(id)
      active += 1
      peak = Math.max(peak, active)
      await gate.promise
      active -= 1
      release()
    }

    const firstPass = scheduler.warm("https://hub.example", [
      warm("connection-a/one", blocked[0]),
      warm("connection-a/two", blocked[1]),
      warm("connection-b/one", blocked[2]),
    ])
    await settle()
    const overlappingPass = scheduler.warm("https://hub.example", [warm("connection-b/two", blocked[3])])
    await settle()

    expect(started).toEqual(["connection-a/one", "connection-a/two", "connection-b/one"])
    expect(peak).toBe(3)

    const releaseForeground = await requests.acquire("foreground/session-load")
    expect(requests.active).toEqual(
      new Set(["connection-a/one", "connection-a/two", "connection-b/one", "foreground/session-load"]),
    )
    expect(started).not.toContain("connection-b/two")
    releaseForeground()

    blocked[0].resolve()
    await settle()
    expect(started).toContain("connection-b/two")

    blocked[1].resolve()
    blocked[2].resolve()
    blocked[3].resolve()
    await Promise.all([firstPass, overlappingPass])
  })

  test("coalesces overlapping work for the same stable session identity", async () => {
    const scheduler = createSessionWarmScheduler()
    const gate = deferred()
    let calls = 0
    const chain = async () => {
      calls += 1
      await gate.promise
    }

    const firstPass = scheduler.warm("https://hub.example", [{ id: "session-a", chain }])
    const overlappingPass = scheduler.warm("https://hub.example", [{ id: "session-a", chain }])
    await settle()

    expect(calls).toBe(1)
    gate.resolve()
    await Promise.all([firstPass, overlappingPass])
  })

  test("releases scheduler slots after prefetch when lineage never settles", async () => {
    const scheduler = createSessionWarmScheduler()
    const prefetched: string[] = []
    const warm = (id: string) => ({
      id,
      chain: () =>
        warmBulkSession({
          remember: () => {},
          hasLineage: () => false,
          resolveLineage: () => new Promise(() => {}),
          shouldPrefetch: () => true,
          prefetch: async () => {
            prefetched.push(id)
          },
        }),
    })

    void scheduler.warm("https://hub.example", [warm("one"), warm("two"), warm("three")])
    await settle()
    expect(prefetched).toEqual(["one", "two", "three"])

    const fourth = scheduler.warm("https://hub.example", [warm("four")])
    await settle()
    expect(prefetched).toEqual(["one", "two", "three", "four"])
    await fourth
  })

  test("remembers all valid list rows before scheduling either server batch", async () => {
    const stalled = deferred()
    const events: string[] = []
    const scheduled = warmSessionServerBatches({
      servers: ["slow", "ready"],
      list: async (server) =>
        server === "slow" ? [{ id: "slow-a" }, { id: "slow-b" }] : [{ id: "ready-a" }, { id: "ready-b" }],
      normalize: (row) => row,
      remember: (server, row) => events.push(`remember:${server}:${row.id}`),
      warm: async (server, rows) => {
        events.push(`warm:${server}:${rows.map((row) => row.id).join(",")}`)
        if (server === "slow") await stalled.promise
      },
    })

    await settle()
    expect(events).toEqual([
      "remember:slow:slow-a",
      "remember:slow:slow-b",
      "remember:ready:ready-a",
      "remember:ready:ready-b",
      "warm:slow:slow-a,slow-b",
      "warm:ready:ready-a,ready-b",
    ])
    stalled.resolve()
    await scheduled
  })

  test("starts lineage resolution and first-page bulk prefetch independently", async () => {
    const lineage = deferred()
    const calls: number[] = []
    const warming = warmBulkSession({
      remember: () => {},
      hasLineage: () => false,
      resolveLineage: () => lineage.promise,
      shouldPrefetch: () => true,
      prefetch: async (limit) => {
        calls.push(limit)
      },
    })

    await settle()
    expect(calls).toEqual([BULK_WARM_MESSAGES])

    lineage.resolve()
    await warming
    expect(calls).toEqual([BULK_WARM_MESSAGES])
  })

  test("prefetches an eligible session when lineage resolution never settles", async () => {
    const calls: number[] = []

    void warmBulkSession({
      remember: () => {},
      hasLineage: () => false,
      resolveLineage: () => new Promise(() => {}),
      shouldPrefetch: () => true,
      prefetch: async (limit) => {
        calls.push(limit)
      },
    })

    await settle()
    expect(calls).toEqual([BULK_WARM_MESSAGES])
  })

  test("prefetches an eligible session even when its lineage lookup fails", async () => {
    const calls: number[] = []

    await warmBulkSession({
      remember: () => {},
      hasLineage: () => false,
      resolveLineage: async () => {
        throw new Error("lineage unavailable")
      },
      shouldPrefetch: () => true,
      prefetch: async (limit) => {
        calls.push(limit)
      },
    })

    expect(calls).toEqual([BULK_WARM_MESSAGES])
  })

  test("warms open tabs with 20 messages before their 60-message follow-up", async () => {
    const firstPage = deferred()
    const calls: number[] = []
    const warming = warmOpenSessionTab("tab", async (_sessionID, limit) => {
      calls.push(limit)
      if (limit === 20) await firstPage.promise
    })

    await settle()
    expect(calls).toEqual([20])

    firstPage.resolve()
    await warming
    expect(calls).toEqual([20, 60])
  })
})
