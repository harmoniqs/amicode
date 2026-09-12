import { describe, expect, test } from "bun:test"
import { findTaskSession, isAmicodeToolCall } from "./message-part-task"

// Minimal session stub — only the fields findTaskSession reads.
function session(overrides: {
  id: string
  parentID?: string
  title?: string
  archived?: number
  created?: number
}) {
  return {
    id: overrides.id,
    parentID: overrides.parentID,
    title: overrides.title as string, // intentionally allow undefined to match runtime
    time: {
      created: overrides.created ?? Date.now(),
      updated: Date.now(),
      archived: overrides.archived,
    },
  } as any
}

describe("findTaskSession", () => {
  test("returns matching child session id", () => {
    const sessions = [
      session({ id: "child-1", parentID: "p1", title: "Fix bug @general", created: 100 }),
    ]
    expect(findTaskSession(sessions, "p1", "Fix bug", "general")).toBe("child-1")
  })

  test("returns undefined when no sessions match parentID", () => {
    const sessions = [
      session({ id: "child-1", parentID: "other", title: "Fix bug @general" }),
    ]
    expect(findTaskSession(sessions, "p1", "Fix bug", "general")).toBeUndefined()
  })

  test("skips archived sessions", () => {
    const sessions = [
      session({ id: "child-1", parentID: "p1", title: "Fix bug @general", archived: 1 }),
    ]
    expect(findTaskSession(sessions, "p1", "Fix bug", "general")).toBeUndefined()
  })

  test("returns most recently created when multiple match", () => {
    const sessions = [
      session({ id: "old", parentID: "p1", title: "Fix bug @general", created: 100 }),
      session({ id: "new", parentID: "p1", title: "Fix bug @general", created: 200 }),
    ]
    expect(findTaskSession(sessions, "p1", "Fix bug", "general")).toBe("new")
  })

  test("does not crash when a session has undefined title", () => {
    const sessions = [
      session({ id: "no-title", parentID: "p1", title: undefined }),
      session({ id: "titled", parentID: "p1", title: "Fix bug @general", created: 200 }),
    ]
    // Should not throw — must gracefully skip the untitled session
    expect(() => findTaskSession(sessions, "p1", "Fix bug", "general")).not.toThrow()
    expect(findTaskSession(sessions, "p1", "Fix bug", "general")).toBe("titled")
  })

  test("does not crash when all sessions have undefined title", () => {
    const sessions = [
      session({ id: "a", parentID: "p1", title: undefined }),
      session({ id: "b", parentID: "p1", title: undefined }),
    ]
    expect(() => findTaskSession(sessions, "p1", "task", "general")).not.toThrow()
    expect(findTaskSession(sessions, "p1", "task", "general")).toBeUndefined()
  })

  test("skips title filter when description is empty", () => {
    const sessions = [
      session({ id: "child-1", parentID: "p1", title: undefined }),
    ]
    // With empty description the startsWith filter is bypassed, but
    // the includes(@agent) filter still runs on undefined title
    expect(() => findTaskSession(sessions, "p1", "", "")).not.toThrow()
    expect(findTaskSession(sessions, "p1", "", "")).toBe("child-1")
  })

  test("handles empty session list", () => {
    expect(findTaskSession([], "p1", "desc", "general")).toBeUndefined()
  })
})

describe("isAmicodeToolCall", () => {
  test("returns true for amicode_ prefixed tool part", () => {
    expect(isAmicodeToolCall({ type: "tool", tool: "amicode_solve" })).toBe(true)
  })

  test("returns false for non-tool part", () => {
    expect(isAmicodeToolCall({ type: "text", tool: "amicode_solve" })).toBe(false)
  })

  test("returns false when part is undefined", () => {
    expect(isAmicodeToolCall(undefined)).toBe(false)
  })

  test("does not crash when tool property is undefined", () => {
    // A tool-type part with missing tool name — should not throw
    expect(() => isAmicodeToolCall({ type: "tool", tool: undefined })).not.toThrow()
    expect(isAmicodeToolCall({ type: "tool", tool: undefined })).toBe(false)
  })

  test("does not crash when tool property is null", () => {
    expect(() => isAmicodeToolCall({ type: "tool", tool: null })).not.toThrow()
    expect(isAmicodeToolCall({ type: "tool", tool: null })).toBe(false)
  })

  test("returns false for non-amicode tool", () => {
    expect(isAmicodeToolCall({ type: "tool", tool: "bash" })).toBe(false)
  })
})
