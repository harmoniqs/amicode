import { describe, expect, test } from "bun:test"
import { createPreviewDraftStore } from "./preview-draft-store"

// #1249: unsaved Preview edits live in an in-memory store keyed by
// (session, path) so a session-tab switch (which remounts the Preview) neither
// leaks one session's draft into another nor silently discards it.

describe("draft isolation + restoration", () => {
  test("session B never sees a draft created in session A for the same file", () => {
    const store = createPreviewDraftStore()
    store.write("ses_a", "/p/a.md", "edited in A")
    expect(store.get("ses_b", "/p/a.md")).toBeUndefined()
    expect(store.paths("ses_b")).toEqual([])
  })

  test("returning to A restores its exact draft and its dirty paths (incl. an inactive document)", () => {
    const store = createPreviewDraftStore()
    store.write("ses_a", "/p/a.md", "draft one")
    store.write("ses_a", "/p/b.md", "draft two")
    store.write("ses_a", "/p/a.md", "draft one, edited more")
    store.write("ses_b", "/p/a.md", "B's own")
    expect(store.get("ses_a", "/p/a.md")?.content).toBe("draft one, edited more")
    expect(store.get("ses_a", "/p/b.md")?.content).toBe("draft two")
    expect(store.paths("ses_a")).toEqual(["/p/a.md", "/p/b.md"])
    expect(store.get("ses_b", "/p/a.md")?.content).toBe("B's own")
  })

  test("the store has no eviction: nothing but save/discard/close removes a dirty draft", () => {
    const store = createPreviewDraftStore()
    store.write("ses_a", "/p/a.md", "keep me")
    // Switching sessions (reads/writes elsewhere) never touches it.
    store.write("ses_b", "/p/x.md", "x")
    store.get("ses_c", "/p/a.md")
    expect(store.get("ses_a", "/p/a.md")?.content).toBe("keep me")
  })
})

describe("revisioned clear", () => {
  test("a save of revision N clears the draft only if no newer edit landed", () => {
    const store = createPreviewDraftStore()
    const saved = store.write("ses_a", "/p/a.md", "v1")
    store.write("ses_a", "/p/a.md", "v2") // typed while the save was in flight
    expect(store.clear("ses_a", "/p/a.md", saved)).toBe(false)
    expect(store.get("ses_a", "/p/a.md")?.content).toBe("v2")
  })

  test("a matching revision clears only that session's draft", () => {
    const store = createPreviewDraftStore()
    const rev = store.write("ses_a", "/p/a.md", "v1")
    store.write("ses_b", "/p/a.md", "B")
    expect(store.clear("ses_a", "/p/a.md", rev)).toBe(true)
    expect(store.get("ses_a", "/p/a.md")).toBeUndefined()
    expect(store.get("ses_b", "/p/a.md")?.content).toBe("B")
  })

  test("a stale save completion cannot clear a reopened draft (older revision, same path)", () => {
    const store = createPreviewDraftStore()
    const old = store.write("ses_a", "/p/a.md", "old")
    store.clear("ses_a", "/p/a.md") // explicit discard / close
    store.write("ses_a", "/p/a.md", "reopened and edited")
    expect(store.clear("ses_a", "/p/a.md", old)).toBe(false)
    expect(store.get("ses_a", "/p/a.md")?.content).toBe("reopened and edited")
  })

  test("an unrevisioned clear is the explicit discard/close", () => {
    const store = createPreviewDraftStore()
    store.write("ses_a", "/p/a.md", "x")
    expect(store.clear("ses_a", "/p/a.md")).toBe(true)
    expect(store.clear("ses_a", "/p/a.md")).toBe(false)
  })
})

describe("settling a save", () => {
  test("a save settles (clears) its own revision, and a joined second settle still reads as saved", () => {
    const store = createPreviewDraftStore()
    const rev = store.write("ses_a", "/p/a.md", "v1")
    expect(store.settle("ses_a", "/p/a.md", rev)).toBe(true)
    expect(store.get("ses_a", "/p/a.md")).toBeUndefined()
    expect(store.settle("ses_a", "/p/a.md", rev)).toBe(true) // the close-save that joined the write
  })

  test("a newer edit (or a reopened draft) keeps the document dirty", () => {
    const store = createPreviewDraftStore()
    const rev = store.write("ses_a", "/p/a.md", "v1")
    store.write("ses_a", "/p/a.md", "v2")
    expect(store.settle("ses_a", "/p/a.md", rev)).toBe(false)
    expect(store.get("ses_a", "/p/a.md")?.content).toBe("v2")
  })
})

describe("save serialization per file", () => {
  const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>((r) => (resolve = r))
    return { promise, resolve }
  }

  test("repeated saves of one file run one at a time, in order", async () => {
    const store = createPreviewDraftStore()
    const log: string[] = []
    const first = deferred()
    const a = store.enqueueSave("srv|proj|/p/a.md", "one", async () => {
      log.push("start one")
      await first.promise
      log.push("end one")
    })
    const b = store.enqueueSave("srv|proj|/p/a.md", "two", async () => {
      log.push("start two")
    })
    await Promise.resolve()
    expect(log).toEqual(["start one"]) // two has not started
    first.resolve()
    await Promise.all([a, b])
    expect(log).toEqual(["start one", "end one", "start two"])
  })

  test("a close-save joins the in-flight save of the same content instead of writing twice", async () => {
    const store = createPreviewDraftStore()
    let writes = 0
    const gate = deferred()
    const a = store.enqueueSave("k", "same", async () => {
      writes++
      await gate.promise
    })
    const b = store.enqueueSave("k", "same", async () => {
      writes++
    })
    gate.resolve()
    await Promise.all([a, b])
    expect(writes).toBe(1)
  })

  test("different files do not block each other; a failed save does not wedge the queue", async () => {
    const store = createPreviewDraftStore()
    const gate = deferred()
    const slow = store.enqueueSave("k1", "x", () => gate.promise)
    let ran = false
    await store.enqueueSave("k2", "y", async () => {
      ran = true
    })
    expect(ran).toBe(true)
    gate.resolve()
    await slow

    await store.enqueueSave("k3", "a", async () => {
      throw new Error("boom")
    }).catch(() => {})
    let after = false
    await store.enqueueSave("k3", "b", async () => {
      after = true
    })
    expect(after).toBe(true)
  })
})

describe("session-owned close intent", () => {
  test("a close request survives a session switch (it lives in the store, not the component)", () => {
    const store = createPreviewDraftStore()
    const token = store.requestClose("ses_a", "/p/a.md")
    expect(token).toBeDefined()
    expect(store.closeRequest("ses_a")).toEqual({ path: "/p/a.md", token: token! })
    expect(store.closeRequest("ses_b")).toBeUndefined()
  })

  test("a second tab cannot replace the active decision", () => {
    const store = createPreviewDraftStore()
    const token = store.requestClose("ses_a", "/p/a.md")
    expect(store.requestClose("ses_a", "/p/b.md")).toBeUndefined()
    expect(store.closeRequest("ses_a")?.path).toBe("/p/a.md")
    // Re-requesting the same path rejoins the same decision.
    expect(store.requestClose("ses_a", "/p/a.md")).toBe(token)
  })

  test("a resolved close reaches the session's LIVE Preview, even if a different mount asked", () => {
    const store = createPreviewDraftStore()
    const closed: string[] = []
    const token = store.requestClose("ses_a", "/p/a.md")!
    // The asking mount was disposed by a session switch; a fresh mount subscribed.
    const stale = store.onClosed("ses_a", (p) => closed.push(`stale:${p}`))
    stale()
    const unsubscribe = store.onClosed("ses_a", (p) => closed.push(`live:${p}`))
    store.onClosed("ses_b", (p) => closed.push(`other:${p}`))
    expect(store.resolveClose("ses_a", token)).toBe(true)
    expect(closed).toEqual(["live:/p/a.md"])
    unsubscribe()
  })

  test("resolving completes the close only for the current token; a canceled request never closes", () => {
    const store = createPreviewDraftStore()
    const token = store.requestClose("ses_a", "/p/a.md")!
    expect(store.cancelClose("ses_a", token)).toBe(true)
    expect(store.resolveClose("ses_a", token)).toBe(false) // write finished after cancel: stay open
    const next = store.requestClose("ses_a", "/p/a.md")!
    expect(next).not.toBe(token)
    expect(store.resolveClose("ses_a", token)).toBe(false) // stale token
    expect(store.resolveClose("ses_a", next)).toBe(true)
    expect(store.closeRequest("ses_a")).toBeUndefined()
  })
})
