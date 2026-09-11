import { describe, expect, test, beforeEach } from "bun:test"
import {
  createPreviewFileStates,
  type PreviewFileState,
} from "./preview-nav-state"

/**
 * Tests for the Preview tab file state manager (#933 — stripped Finder,
 * kept per-file state: mode, scroll, unsaved content).
 *
 * Pure logic — no SolidJS, no DOM.
 */

// ---------------------------------------------------------------------------
// createPreviewFileStates — per-file state persistence
// ---------------------------------------------------------------------------

describe("createPreviewFileStates", () => {
  let states: ReturnType<typeof createPreviewFileStates>

  beforeEach(() => {
    states = createPreviewFileStates()
  })

  test("getFileState returns default for unknown file", () => {
    expect(states.get("unknown.md")).toEqual({
      mode: "preview",
      scrollPosition: 0,
      unsavedContent: null,
    })
  })

  test("setFileState persists state for a file", () => {
    states.set("README.md", { mode: "edit", scrollPosition: 150, unsavedContent: null })
    expect(states.get("README.md")).toEqual({
      mode: "edit",
      scrollPosition: 150,
      unsavedContent: null,
    })
  })

  test("setFileState replaces entire state for a file", () => {
    states.set("README.md", { mode: "preview", scrollPosition: 0, unsavedContent: null })
    states.set("README.md", { mode: "edit", scrollPosition: 0, unsavedContent: "edited" })
    expect(states.get("README.md")).toEqual({
      mode: "edit",
      scrollPosition: 0,
      unsavedContent: "edited",
    })
  })

  test("file states persist across different files", () => {
    states.set("README.md", { mode: "edit", scrollPosition: 100, unsavedContent: null })
    states.set("src/app.ts", { mode: "edit", scrollPosition: 200, unsavedContent: "code" })

    expect(states.get("README.md").scrollPosition).toBe(100)
    expect(states.get("src/app.ts").scrollPosition).toBe(200)
    expect(states.get("src/app.ts").unsavedContent).toBe("code")
  })

  test("switching away from a file and back restores its state", () => {
    // Simulate: open file A, set edit mode + scroll, open file B, come back to A
    states.set("fileA.md", { mode: "edit", scrollPosition: 42, unsavedContent: "draft" })
    states.set("fileB.md", { mode: "preview", scrollPosition: 0, unsavedContent: null })

    // File A's state should still be intact
    expect(states.get("fileA.md")).toEqual({
      mode: "edit",
      scrollPosition: 42,
      unsavedContent: "draft",
    })
  })

  test("getAll returns the full fileStates record", () => {
    states.set("a.md", { mode: "edit", scrollPosition: 0, unsavedContent: null })
    states.set("b.ts", { mode: "preview", scrollPosition: 50, unsavedContent: null })

    const all = states.getAll()
    expect(Object.keys(all)).toHaveLength(2)
    expect(all["a.md"]?.mode).toBe("edit")
    expect(all["b.ts"]?.scrollPosition).toBe(50)
  })

  test("getAll returns empty object when no states recorded", () => {
    expect(states.getAll()).toEqual({})
  })
})
