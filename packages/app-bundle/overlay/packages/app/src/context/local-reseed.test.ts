import { describe, expect, test } from "bun:test"
import { runLocalReseed, type LocalReseedDeps, type LocalStatus } from "./local-reseed"

// amicode#1767 — the LOCAL status re-seed (machines without fleet peers) reads
// the engine's /session/status PER DIRECTORY, for the directories of the pinned
// sessions only. A directory-less read resolves to the engine's own working dir
// (a temp dir under the service runner) and returns {} for every real session.

const busy: LocalStatus = { type: "busy" }

function harness(over: Partial<LocalReseedDeps> & { dirs?: Record<string, string>; status?: Record<string, Record<string, LocalStatus>> } = {}) {
  const reads: Array<string | undefined> = []
  const reconciled: Array<{ statuses: Record<string, LocalStatus>; fetchedAt: number }> = []
  const dirs = over.dirs ?? {}
  const status = over.status ?? {}
  const deps: LocalReseedDeps = {
    pinnedIds: () => Object.keys(dirs),
    directoryOf: (id) => dirs[id],
    resolve: async () => undefined,
    readStatus: async (directory) => {
      reads.push(directory)
      return status[directory] ?? {}
    },
    reconcile: (statuses, opts) => reconciled.push({ statuses, fetchedAt: opts.fetchedAt }),
    now: () => 1234,
    ...over,
  }
  return { deps, reads, reconciled }
}

describe("runLocalReseed — per-directory status for pinned sessions", () => {
  test("a pinned session busy in its directory becomes busy in the store", async () => {
    const h = harness({ dirs: { s1: "/work/a" }, status: { "/work/a": { s1: busy } } })
    await runLocalReseed(h.deps)
    expect(h.reads).toEqual(["/work/a"])
    expect(h.reconciled).toEqual([{ statuses: { s1: busy }, fetchedAt: 1234 }])
  })

  test("never reads a directory that is not a pinned session's own", async () => {
    // s2 exists in /work/b but is not pinned: /work/b is never read, and neither
    // is any directory-less (undefined) status
    const h = harness({
      dirs: { s1: "/work/a" },
      pinnedIds: () => ["s1"],
      directoryOf: (id) => ({ s1: "/work/a", s2: "/work/b" })[id],
      status: { "/work/a": {}, "/work/b": { s2: busy } },
    })
    await runLocalReseed(h.deps)
    expect(h.reads).toEqual(["/work/a"])
    expect(h.reads).not.toContain(undefined)
  })

  test("sessions sharing a directory cost one read; distinct directories one each", async () => {
    const h = harness({
      dirs: { s1: "/work/a", s2: "/work/a", s3: "/work/c" },
      status: { "/work/a": { s1: busy }, "/work/c": { s3: busy } },
    })
    await runLocalReseed(h.deps)
    expect(h.reads.sort()).toEqual(["/work/a", "/work/c"])
    expect(h.reconciled.length).toBe(2)
  })

  test("nothing pinned → no read at all (never a directory-less read)", async () => {
    const h = harness({ dirs: {} })
    await runLocalReseed(h.deps)
    expect(h.reads).toEqual([])
    expect(h.reconciled).toEqual([])
  })

  test("a pinned session whose info is not cached is resolved first, then read in its directory", async () => {
    const dirs: Record<string, string> = {}
    const h = harness({
      pinnedIds: () => ["s1"],
      directoryOf: (id) => dirs[id],
      resolve: async (id) => {
        dirs[id] = "/work/a"
      },
      status: { "/work/a": { s1: busy } },
    })
    await runLocalReseed(h.deps)
    expect(h.reads).toEqual(["/work/a"])
    expect(h.reconciled[0]?.statuses).toEqual({ s1: busy })
  })

  test("an unresolvable pinned session is skipped (no directory guessed)", async () => {
    const h = harness({
      pinnedIds: () => ["ghost", "s1"],
      directoryOf: (id) => ({ s1: "/work/a" })[id],
      resolve: async (id) => {
        if (id === "ghost") throw new Error("not found")
      },
      status: { "/work/a": { s1: busy } },
    })
    await runLocalReseed(h.deps)
    expect(h.reads).toEqual(["/work/a"])
  })

  test("one directory's failed read does not block the others; never throws", async () => {
    const h = harness({
      dirs: { s1: "/work/a", s3: "/work/c" },
      readStatus: async (directory) => {
        if (directory === "/work/a") throw new Error("boom")
        return { s3: busy }
      },
    })
    await runLocalReseed(h.deps)
    expect(h.reconciled).toEqual([{ statuses: { s3: busy }, fetchedAt: 1234 }])
  })

  test("the fetch is timestamped BEFORE the reads (the recency guard's contract)", async () => {
    let t = 100
    const h = harness({
      dirs: { s1: "/work/a" },
      now: () => t,
      readStatus: async () => {
        t = 999
        return { s1: busy }
      },
    })
    await runLocalReseed(h.deps)
    expect(h.reconciled[0]?.fetchedAt).toBe(100)
  })
})
