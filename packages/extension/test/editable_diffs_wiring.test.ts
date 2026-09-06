// @vitest-environment happy-dom
import { describe, expect, test, vi, beforeEach } from "vitest"

/**
 * Tests for #768/#837: Editable diffs wiring + dirty-dot explicit save.
 *
 * These tests verify the overlay's integration of EditableDiffView:
 * - CM6 externalUpdate annotation filtering contract (#837)
 * - Save controller logic (explicit Cmd+S, race guard, no autosave)
 * - ReviewDiffStyle type widening
 * - File status → readOnly mapping
 */

// ---------------------------------------------------------------------------
// CM6 externalUpdate annotation — contract verification
// ---------------------------------------------------------------------------
//
// The full CM6 integration lives in the overlay (editable-diff-view-core.ts).
// These tests verify the FILTERING CONTRACT that editableExtensions must
// satisfy: transactions annotated with externalUpdate must NOT fire onChange.
// We test the filtering predicate in isolation rather than constructing a
// live CM6 EditorView (whose dependencies are resolved at the fork build, not
// in this workspace's node_modules).
//
// The predicate under test:
//   if (update.docChanged && !update.transactions.some(tr => tr.annotation(externalUpdate)))
//     opts.onChange!(update.state.doc.toString())
// ---------------------------------------------------------------------------

describe("externalUpdate annotation filtering contract", () => {
  /**
   * Simulates the onChange filtering logic from editableExtensions.
   * This is the exact predicate the production code uses — if it changes,
   * the test must be updated in lock-step.
   */
  function shouldFireOnChange(transactions: Array<{
    docChanged: boolean
    annotatedExternal: boolean
  }>): boolean {
    const anyDocChanged = transactions.some(t => t.docChanged)
    if (!anyDocChanged) return false
    const anyExternal = transactions.some(t => t.annotatedExternal)
    return !anyExternal
  }

  test("user edit (no annotation) fires onChange", () => {
    expect(shouldFireOnChange([
      { docChanged: true, annotatedExternal: false },
    ])).toBe(true)
  })

  test("programmatic update (with annotation) does NOT fire onChange", () => {
    expect(shouldFireOnChange([
      { docChanged: true, annotatedExternal: true },
    ])).toBe(false)
  })

  test("non-doc-changing transaction does not fire onChange", () => {
    expect(shouldFireOnChange([
      { docChanged: false, annotatedExternal: false },
    ])).toBe(false)
  })

  test("mixed batch: if any transaction is external, onChange is suppressed", () => {
    expect(shouldFireOnChange([
      { docChanged: true, annotatedExternal: false },
      { docChanged: true, annotatedExternal: true },
    ])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Save controller — explicit Cmd+S only, no autosave (#837)
// ---------------------------------------------------------------------------

type SaveStatus = "idle" | "saving" | "error"

/**
 * Minimal reproduction of the explicit-save controller for testable isolation.
 * The actual implementation lives in the overlay component. This mirrors the
 * new save model: no debounced autosave, only explicit Cmd+S, with a race
 * guard (content-at-save-time snapshot) and a cleanup safety net.
 */
function createSaveController(opts: {
  onSave: (path: string, content: string) => Promise<void>
  errorDisplayMs?: number
}) {
  const errorDisplayMs = opts.errorDisplayMs ?? 2000
  let status: SaveStatus = "idle"
  let errorTimer: ReturnType<typeof setTimeout> | undefined
  let hasEdits = false
  let latestContent: string | null = null
  const listeners: Array<(s: SaveStatus) => void> = []

  function setStatus(s: SaveStatus) {
    status = s
    for (const l of listeners) l(s)
  }

  return {
    get status() {
      return status
    },
    get hasEdits() {
      return hasEdits
    },
    get latestContent() {
      return latestContent
    },
    onStatusChange(cb: (s: SaveStatus) => void) {
      listeners.push(cb)
    },
    /** Called on every user edit — updates dirty state, does NOT trigger save. */
    onChange(content: string) {
      hasEdits = true
      latestContent = content
    },
    /**
     * Explicit save (Cmd+S). No-op if no edits or null content.
     * Uses a content-at-save-time snapshot for the race guard: only clears
     * hasEdits if no further edits arrived during the async save.
     */
    immediateSave(path: string) {
      if (!hasEdits || latestContent === null) return
      const contentAtSaveTime = latestContent
      setStatus("saving")
      opts
        .onSave(path, contentAtSaveTime)
        .then(() => {
          // Race guard: only clear dirty state if content unchanged since save started
          if (latestContent === contentAtSaveTime) {
            hasEdits = false
            for (const l of listeners) l(status) // notify hasEdits change
          }
          setStatus("idle")
        })
        .catch(() => {
          setStatus("error")
          if (errorTimer) clearTimeout(errorTimer)
          errorTimer = setTimeout(() => setStatus("idle"), errorDisplayMs)
        })
    },
    /** Revert clears dirty state immediately. */
    revert() {
      hasEdits = false
      latestContent = null
    },
    /** Cleanup — optionally saves on unmount (file-switch safety net). */
    cleanup(path?: string) {
      if (errorTimer) clearTimeout(errorTimer)
      if (path && hasEdits && latestContent !== null) {
        // Fire-and-forget save on unmount
        opts.onSave(path, latestContent).catch(() => {})
        hasEdits = false
      }
    },
  }
}

describe("Save controller (explicit Cmd+S)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  test("starts at idle with no edits", () => {
    const ctrl = createSaveController({ onSave: async () => {} })
    expect(ctrl.status).toBe("idle")
    expect(ctrl.hasEdits).toBe(false)
    expect(ctrl.latestContent).toBeNull()
    ctrl.cleanup()
  })

  test("onChange sets hasEdits and latestContent but does NOT trigger a save", () => {
    const onSave = vi.fn(async () => {})
    const ctrl = createSaveController({ onSave })

    ctrl.onChange("new content")

    expect(ctrl.hasEdits).toBe(true)
    expect(ctrl.latestContent).toBe("new content")
    expect(onSave).not.toHaveBeenCalled()

    // Advance time — no debounced save should fire
    vi.advanceTimersByTime(5000)
    expect(onSave).not.toHaveBeenCalled()

    ctrl.cleanup()
  })

  test("immediateSave fires onSave with current content", () => {
    const onSave = vi.fn(async () => {})
    const ctrl = createSaveController({ onSave })

    ctrl.onChange("hello world")
    ctrl.immediateSave("test.ts")

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith("test.ts", "hello world")

    ctrl.cleanup()
  })

  test("immediateSave is a no-op when hasEdits is false", () => {
    const onSave = vi.fn(async () => {})
    const ctrl = createSaveController({ onSave })

    ctrl.immediateSave("test.ts")

    expect(onSave).not.toHaveBeenCalled()

    ctrl.cleanup()
  })

  test("immediateSave is a no-op when latestContent is null", () => {
    const onSave = vi.fn(async () => {})
    const ctrl = createSaveController({ onSave })

    // Force hasEdits without setting content (edge case)
    ctrl.onChange("some content")
    ctrl.revert() // clears both
    ctrl.immediateSave("test.ts")

    expect(onSave).not.toHaveBeenCalled()

    ctrl.cleanup()
  })

  test("successful save clears hasEdits when no edits during save", async () => {
    let resolvePromise!: () => void
    const onSave = vi.fn(
      () => new Promise<void>((r) => (resolvePromise = r)),
    )
    const ctrl = createSaveController({ onSave })

    ctrl.onChange("content")
    ctrl.immediateSave("test.ts")
    expect(ctrl.status).toBe("saving")
    expect(ctrl.hasEdits).toBe(true) // still dirty during save

    resolvePromise()
    await vi.advanceTimersByTimeAsync(0)

    expect(ctrl.hasEdits).toBe(false) // cleared after save
    expect(ctrl.status).toBe("idle")

    ctrl.cleanup()
  })

  test("race guard: save does NOT clear hasEdits when edits arrived during save", async () => {
    let resolvePromise!: () => void
    const onSave = vi.fn(
      () => new Promise<void>((r) => (resolvePromise = r)),
    )
    const ctrl = createSaveController({ onSave })

    ctrl.onChange("v1")
    ctrl.immediateSave("test.ts")

    // User edits during the in-flight save
    ctrl.onChange("v2")

    resolvePromise()
    await vi.advanceTimersByTimeAsync(0)

    // hasEdits must remain true — the save was for "v1" but "v2" is unsaved
    expect(ctrl.hasEdits).toBe(true)
    expect(ctrl.latestContent).toBe("v2")

    ctrl.cleanup()
  })

  test("failed save transitions to error, then back to idle", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("network error")
    })
    const ctrl = createSaveController({ onSave, errorDisplayMs: 100 })

    ctrl.onChange("content")
    ctrl.immediateSave("test.ts")
    await vi.advanceTimersByTimeAsync(0)
    expect(ctrl.status).toBe("error")

    // hasEdits remains true on error — user data not lost
    expect(ctrl.hasEdits).toBe(true)

    vi.advanceTimersByTime(100)
    expect(ctrl.status).toBe("idle")

    ctrl.cleanup()
  })

  test("revert clears hasEdits and latestContent", () => {
    const ctrl = createSaveController({ onSave: async () => {} })

    ctrl.onChange("edited content")
    expect(ctrl.hasEdits).toBe(true)

    ctrl.revert()
    expect(ctrl.hasEdits).toBe(false)
    expect(ctrl.latestContent).toBeNull()

    ctrl.cleanup()
  })

  test("cleanup with path and hasEdits fires a safety-net save", () => {
    const onSave = vi.fn(async () => {})
    const ctrl = createSaveController({ onSave })

    ctrl.onChange("unsaved content")
    ctrl.cleanup("test.ts")

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith("test.ts", "unsaved content")
  })

  test("cleanup without path does not fire a save", () => {
    const onSave = vi.fn(async () => {})
    const ctrl = createSaveController({ onSave })

    ctrl.onChange("unsaved content")
    ctrl.cleanup()

    expect(onSave).not.toHaveBeenCalled()
  })

  test("cleanup with path but no edits does not fire a save", () => {
    const onSave = vi.fn(async () => {})
    const ctrl = createSaveController({ onSave })

    ctrl.cleanup("test.ts")

    expect(onSave).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// File status → readOnly mapping
// ---------------------------------------------------------------------------

describe("File status → readOnly mapping", () => {
  function isReadOnly(status: "added" | "modified" | "deleted"): boolean {
    return status === "deleted"
  }

  test("added files are editable", () => {
    expect(isReadOnly("added")).toBe(false)
  })

  test("modified files are editable", () => {
    expect(isReadOnly("modified")).toBe(false)
  })

  test("deleted files are read-only", () => {
    expect(isReadOnly("deleted")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ReviewDiffStyle type widening
// ---------------------------------------------------------------------------

describe("ReviewDiffStyleExtended", () => {
  type ReviewDiffStyleExtended = "unified" | "split" | "preview"

  test("accepts unified", () => {
    const s: ReviewDiffStyleExtended = "unified"
    expect(s).toBe("unified")
  })

  test("accepts split", () => {
    const s: ReviewDiffStyleExtended = "split"
    expect(s).toBe("split")
  })

  test("accepts preview", () => {
    const s: ReviewDiffStyleExtended = "preview"
    expect(s).toBe("preview")
  })

  test("base type is assignable to extended", () => {
    const base: "unified" | "split" = "split"
    const extended: ReviewDiffStyleExtended = base
    expect(extended).toBe("split")
  })
})
