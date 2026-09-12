import { describe, expect, test } from "bun:test"
import type { PreviewFileState } from "./preview-nav-state"

/**
 * Tests for the mode rename from "raw" to "edit" (Slice 4 of #912).
 * Verifies that the type system reflects the rename.
 */

describe("PreviewFileState mode values", () => {
  test('mode accepts "preview"', () => {
    const state: PreviewFileState = { mode: "preview", scrollPosition: 0, unsavedContent: null }
    expect(state.mode).toBe("preview")
  })

  test('mode accepts "edit" (renamed from "raw")', () => {
    const state: PreviewFileState = { mode: "edit", scrollPosition: 0, unsavedContent: null }
    expect(state.mode).toBe("edit")
  })
})
