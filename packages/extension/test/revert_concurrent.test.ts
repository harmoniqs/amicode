import { describe, expect, test, vi, beforeEach } from "vitest"

/**
 * Tests for #770: Revert + concurrent edit handling.
 *
 * Tests the revert controller and concurrent-edit detection logic
 * in isolation from the SolidJS component.
 */

// ---------------------------------------------------------------------------
// Revert controller
// ---------------------------------------------------------------------------

function createRevertController(opts: {
  getOriginal: () => string
  getCurrentContent: () => string
  onSave: (path: string, content: string) => Promise<void>
  onRevertEditor: () => void
}) {
  let hasEdits = false

  return {
    get hasEdits() {
      return hasEdits
    },
    markEdited() {
      hasEdits = true
    },
    async revert(path: string) {
      const original = opts.getOriginal()
      // Write original content to disk
      await opts.onSave(path, original)
      // Reset the editor (clears undo history via the CM6 onRevert callback)
      opts.onRevertEditor()
      hasEdits = false
    },
    reset() {
      hasEdits = false
    },
  }
}

describe("Revert controller", () => {
  test("hasEdits starts false", () => {
    const ctrl = createRevertController({
      getOriginal: () => "original",
      getCurrentContent: () => "modified",
      onSave: async () => {},
      onRevertEditor: () => {},
    })
    expect(ctrl.hasEdits).toBe(false)
  })

  test("markEdited sets hasEdits to true", () => {
    const ctrl = createRevertController({
      getOriginal: () => "original",
      getCurrentContent: () => "modified",
      onSave: async () => {},
      onRevertEditor: () => {},
    })
    ctrl.markEdited()
    expect(ctrl.hasEdits).toBe(true)
  })

  test("revert writes original content to disk", async () => {
    const saves: Array<{ path: string; content: string }> = []
    const ctrl = createRevertController({
      getOriginal: () => "original content",
      getCurrentContent: () => "user edits",
      onSave: async (path, content) => {
        saves.push({ path, content })
      },
      onRevertEditor: () => {},
    })
    ctrl.markEdited()
    await ctrl.revert("test.ts")

    expect(saves).toEqual([{ path: "test.ts", content: "original content" }])
  })

  test("revert calls onRevertEditor", async () => {
    const editorReverted = vi.fn()
    const ctrl = createRevertController({
      getOriginal: () => "orig",
      getCurrentContent: () => "mod",
      onSave: async () => {},
      onRevertEditor: editorReverted,
    })
    ctrl.markEdited()
    await ctrl.revert("test.ts")

    expect(editorReverted).toHaveBeenCalledTimes(1)
  })

  test("revert resets hasEdits to false", async () => {
    const ctrl = createRevertController({
      getOriginal: () => "orig",
      getCurrentContent: () => "mod",
      onSave: async () => {},
      onRevertEditor: () => {},
    })
    ctrl.markEdited()
    expect(ctrl.hasEdits).toBe(true)

    await ctrl.revert("test.ts")
    expect(ctrl.hasEdits).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Concurrent edit detection
// ---------------------------------------------------------------------------

type ConcurrentEditState = "none" | "detected"

function createConcurrentEditDetector() {
  let state: ConcurrentEditState = "none"
  let lastDiffVersion: string | null = null
  let userHasEdits = false

  return {
    get state() {
      return state
    },
    setUserHasEdits(v: boolean) {
      userHasEdits = v
    },
    /**
     * Called when a new fileDiff prop arrives.
     * Returns true if an external change was detected while user has edits.
     */
    onDiffUpdate(diffVersion: string): boolean {
      if (lastDiffVersion === null) {
        lastDiffVersion = diffVersion
        return false
      }
      if (diffVersion !== lastDiffVersion) {
        lastDiffVersion = diffVersion
        if (userHasEdits) {
          state = "detected"
          return true
        }
      }
      return false
    },
    dismiss() {
      state = "none"
    },
    reload() {
      state = "none"
    },
  }
}

describe("Concurrent edit detection", () => {
  test("starts in none state", () => {
    const det = createConcurrentEditDetector()
    expect(det.state).toBe("none")
  })

  test("first diff update sets baseline, no detection", () => {
    const det = createConcurrentEditDetector()
    const detected = det.onDiffUpdate("v1")
    expect(detected).toBe(false)
    expect(det.state).toBe("none")
  })

  test("same diff version = no detection", () => {
    const det = createConcurrentEditDetector()
    det.onDiffUpdate("v1")
    det.setUserHasEdits(true)
    const detected = det.onDiffUpdate("v1")
    expect(detected).toBe(false)
  })

  test("new diff version with user edits = detected", () => {
    const det = createConcurrentEditDetector()
    det.onDiffUpdate("v1")
    det.setUserHasEdits(true)
    const detected = det.onDiffUpdate("v2")
    expect(detected).toBe(true)
    expect(det.state).toBe("detected")
  })

  test("new diff version without user edits = silent update", () => {
    const det = createConcurrentEditDetector()
    det.onDiffUpdate("v1")
    det.setUserHasEdits(false)
    const detected = det.onDiffUpdate("v2")
    expect(detected).toBe(false)
    expect(det.state).toBe("none")
  })

  test("dismiss clears detected state", () => {
    const det = createConcurrentEditDetector()
    det.onDiffUpdate("v1")
    det.setUserHasEdits(true)
    det.onDiffUpdate("v2")
    expect(det.state).toBe("detected")

    det.dismiss()
    expect(det.state).toBe("none")
  })

  test("reload clears detected state", () => {
    const det = createConcurrentEditDetector()
    det.onDiffUpdate("v1")
    det.setUserHasEdits(true)
    det.onDiffUpdate("v2")

    det.reload()
    expect(det.state).toBe("none")
  })
})
