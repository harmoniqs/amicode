import { describe, expect, test } from "bun:test"
import { rebuildFlagMutation, type RebuildFlagEvent } from "./developer-tools-rebuild-flags"

// ============================================================================
// The devtools rebuild flag protocol (#940): localStorage flags survive
// iframe reloads mid-build (git checkout in a watched workspace triggers a
// reload), so the app's onMount can tell "still rebuilding" apart from
// "finished while you were away". The bug: rebuild() used to set the
// "rebuilt" flag at the SAME time as "rebuilding", so reopening the dialog
// mid-build showed "Rebuilt!" instead of "Rebuilding...". This tests the
// pure decision of what to set/clear at each lifecycle event, independent
// of the SolidJS signal wiring around it.
// ============================================================================

describe("rebuildFlagMutation", () => {
  test("start sets rebuilding+reopen but never rebuilt", () => {
    const mutation = rebuildFlagMutation("start")
    expect(mutation.set).toEqual({ rebuilding: "1", reopen: "1" })
    expect(mutation.clear).toEqual([])
    // The exact regression: "rebuilt" must not appear in the start mutation.
    expect("rebuilt" in mutation.set).toBe(false)
  })

  test("done clears rebuilding and sets rebuilt — the success signal onMount needs", () => {
    const mutation = rebuildFlagMutation("done")
    expect(mutation.clear).toEqual(["rebuilding"])
    expect(mutation.set).toEqual({ rebuilt: "1" })
  })

  test("failed clears rebuilding without ever setting rebuilt", () => {
    const mutation = rebuildFlagMutation("failed")
    expect(mutation.clear).toEqual(["rebuilding"])
    expect(mutation.set).toEqual({})
  })

  test("every event kind produces a defined mutation (exhaustiveness)", () => {
    const events: RebuildFlagEvent[] = ["start", "done", "failed"]
    for (const event of events) {
      expect(rebuildFlagMutation(event)).toBeDefined()
    }
  })
})

describe("rebuild flag lifecycle — localStorage integration", () => {
  const KEY = (suffix: string) => `amicode:devtools-${suffix}`

  function applyMutation(mutation: ReturnType<typeof rebuildFlagMutation>) {
    for (const k of mutation.clear) localStorage.removeItem(KEY(k))
    for (const [k, v] of Object.entries(mutation.set)) localStorage.setItem(KEY(k), v)
  }

  test("reopening mid-build (before 'done' arrives) shows rebuilding, not rebuilt", () => {
    localStorage.clear()
    applyMutation(rebuildFlagMutation("start"))

    // Simulate the dialog reopening mid-build: onMount reads flags directly.
    const wasRebuilding = localStorage.getItem(KEY("rebuilding")) === "1"
    const didFinish = localStorage.getItem(KEY("rebuilt")) === "1"

    expect(wasRebuilding).toBe(true)
    expect(didFinish).toBe(false) // this is the exact bug this fix prevents
  })

  test("full successful lifecycle: start -> done -> reopen shows rebuilt", () => {
    localStorage.clear()
    applyMutation(rebuildFlagMutation("start"))
    applyMutation(rebuildFlagMutation("done"))

    const wasRebuilding = localStorage.getItem(KEY("rebuilding")) === "1"
    const didFinish = localStorage.getItem(KEY("rebuilt")) === "1"

    expect(wasRebuilding).toBe(false)
    expect(didFinish).toBe(true)
  })

  test("failed lifecycle: start -> failed leaves no success flag behind", () => {
    localStorage.clear()
    applyMutation(rebuildFlagMutation("start"))
    applyMutation(rebuildFlagMutation("failed"))

    expect(localStorage.getItem(KEY("rebuilding"))).toBeNull()
    expect(localStorage.getItem(KEY("rebuilt"))).toBeNull()
  })
})
