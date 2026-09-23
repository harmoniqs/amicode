import { describe, expect, test } from "bun:test"
import {
  BULK_WARM_MESSAGES,
  createSessionWarmScheduler,
  sessionWarmSchedulerKey,
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

  test("awaits lineage before the first-page bulk prefetch and never asks bulk warming for a deeper page", async () => {
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
    expect(calls).toEqual([])

    lineage.resolve()
    await warming
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
