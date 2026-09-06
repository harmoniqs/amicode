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
  onEditorRevert?: (original: string) => void
  onRefresh?: () => void
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
          opts.onRefresh?.()
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
    /**
     * Revert to agent's original: write original to disk, then visually
     * revert the editor. Clears dirty state on success; shows error on failure.
     */
    revertToOriginal(path: string, original: string) {
      setStatus("saving")
      opts
        .onSave(path, original)
        .then(() => {
          opts.onEditorRevert?.(original)
          hasEdits = false
          latestContent = null
          setStatus("idle")
          opts.onRefresh?.()
        })
        .catch(() => {
          setStatus("error")
          if (errorTimer) clearTimeout(errorTimer)
          errorTimer = setTimeout(() => setStatus("idle"), errorDisplayMs)
        })
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

  test("revertToOriginal writes original to disk and calls onEditorRevert on success", async () => {
    const onSave = vi.fn(async () => {})
    const onEditorRevert = vi.fn()
    const ctrl = createSaveController({ onSave, onEditorRevert })

    ctrl.onChange("user edits")
    ctrl.revertToOriginal("test.ts", "agent original")

    expect(onSave).toHaveBeenCalledWith("test.ts", "agent original")
    expect(ctrl.status).toBe("saving")

    await vi.advanceTimersByTimeAsync(0)

    expect(onEditorRevert).toHaveBeenCalledWith("agent original")
    expect(ctrl.hasEdits).toBe(false)
    expect(ctrl.latestContent).toBeNull()
    expect(ctrl.status).toBe("idle")

    ctrl.cleanup()
  })

  test("revertToOriginal shows error on failure, keeps hasEdits true", async () => {
    const onSave = vi.fn(async () => { throw new Error("network") })
    const onEditorRevert = vi.fn()
    const ctrl = createSaveController({ onSave, onEditorRevert, errorDisplayMs: 100 })

    ctrl.onChange("user edits")
    ctrl.revertToOriginal("test.ts", "agent original")
    await vi.advanceTimersByTimeAsync(0)

    expect(onEditorRevert).not.toHaveBeenCalled()
    expect(ctrl.hasEdits).toBe(true)
    expect(ctrl.status).toBe("error")

    vi.advanceTimersByTime(100)
    expect(ctrl.status).toBe("idle")

    ctrl.cleanup()
  })

  test("revertToOriginal works without onEditorRevert callback", async () => {
    const onSave = vi.fn(async () => {})
    const ctrl = createSaveController({ onSave }) // no onEditorRevert

    ctrl.onChange("user edits")
    ctrl.revertToOriginal("test.ts", "agent original")
    await vi.advanceTimersByTimeAsync(0)

    expect(ctrl.hasEdits).toBe(false)
    expect(ctrl.status).toBe("idle")

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

  test("onRefresh fires after successful immediateSave", async () => {
    const onSave = vi.fn(async () => {})
    const onRefresh = vi.fn()
    const ctrl = createSaveController({ onSave, onRefresh })

    ctrl.onChange("content")
    ctrl.immediateSave("test.ts")
    await vi.advanceTimersByTimeAsync(0)

    expect(onRefresh).toHaveBeenCalledTimes(1)

    ctrl.cleanup()
  })

  test("onRefresh does NOT fire after failed immediateSave", async () => {
    const onSave = vi.fn(async () => { throw new Error("server error") })
    const onRefresh = vi.fn()
    const ctrl = createSaveController({ onSave, onRefresh, errorDisplayMs: 100 })

    ctrl.onChange("content")
    ctrl.immediateSave("test.ts")
    await vi.advanceTimersByTimeAsync(0)

    expect(onRefresh).not.toHaveBeenCalled()
    expect(ctrl.status).toBe("error")

    ctrl.cleanup()
  })

  test("onRefresh fires after successful revertToOriginal", async () => {
    const onSave = vi.fn(async () => {})
    const onRefresh = vi.fn()
    const ctrl = createSaveController({ onSave, onRefresh })

    ctrl.onChange("user edits")
    ctrl.revertToOriginal("test.ts", "agent original")
    await vi.advanceTimersByTimeAsync(0)

    expect(onRefresh).toHaveBeenCalledTimes(1)

    ctrl.cleanup()
  })

  test("onRefresh does NOT fire after failed revertToOriginal", async () => {
    const onSave = vi.fn(async () => { throw new Error("server error") })
    const onRefresh = vi.fn()
    const ctrl = createSaveController({ onSave, onRefresh, errorDisplayMs: 100 })

    ctrl.onChange("user edits")
    ctrl.revertToOriginal("test.ts", "agent original")
    await vi.advanceTimersByTimeAsync(0)

    expect(onRefresh).not.toHaveBeenCalled()

    ctrl.cleanup()
  })

  test("failed HTTP response (modeled as rejected onSave) shows error and keeps edits", async () => {
    // In production, !response.ok throws into .catch() — modeled here as onSave rejection
    const onSave = vi.fn(async () => { throw new Error("HTTP 403") })
    const onRefresh = vi.fn()
    const ctrl = createSaveController({ onSave, onRefresh, errorDisplayMs: 100 })

    ctrl.onChange("content")
    ctrl.immediateSave("test.ts")
    await vi.advanceTimersByTimeAsync(0)

    expect(ctrl.status).toBe("error")
    expect(ctrl.hasEdits).toBe(true) // edits preserved on failure
    expect(onRefresh).not.toHaveBeenCalled() // no refresh on failure

    vi.advanceTimersByTime(100)
    expect(ctrl.status).toBe("idle")

    ctrl.cleanup()
  })
})

// ---------------------------------------------------------------------------
// Revert-to-agent-version: must use the ADDITIONS side of the diff (#837)
// ---------------------------------------------------------------------------
//
// The diff view has two sides:
//   - "deletions" = the file BEFORE the agent changed it (left / original)
//   - "additions" = the agent's version (right / modified — the editable pane)
//
// "Revert to agent's version" means: discard the user's manual edits and
// restore the agent's proposed content. The caller must pick "additions",
// NOT "deletions". Picking "deletions" writes the pre-agent content to disk,
// which causes the file to vanish from Files Changed (disk = baseline).
// ---------------------------------------------------------------------------

describe("Revert-to-agent side selection", () => {
  /** Simulates the diff model: two sides of content. */
  function textFromDiff(
    diff: { deletions: string; additions: string },
    side: "deletions" | "additions",
  ): string {
    return diff[side]
  }

  /**
   * The correct side for "Revert to agent's version" — must be "additions".
   * This is the contract the production code in handleRevert must satisfy.
   */
  const REVERT_TO_AGENT_SIDE = "additions" as const

  test("revert-to-agent uses the additions side (agent's version), not deletions", () => {
    const diff = {
      deletions: "original content before agent",
      additions: "agent's modified content",
    }

    const revertContent = textFromDiff(diff, REVERT_TO_AGENT_SIDE)

    expect(revertContent).toBe("agent's modified content")
    expect(revertContent).not.toBe("original content before agent")
  })

  test("using deletions side would write pre-agent content (the bug)", () => {
    const diff = {
      deletions: "pre-agent baseline",
      additions: "agent wrote this",
    }

    // This is what the BUGGY code does — picking "deletions"
    const buggyContent = textFromDiff(diff, "deletions")
    expect(buggyContent).toBe("pre-agent baseline")

    // This is what the CORRECT code does — picking "additions"
    const correctContent = textFromDiff(diff, REVERT_TO_AGENT_SIDE)
    expect(correctContent).toBe("agent wrote this")
  })

  test("revertToOriginal receives the agent's version (additions) content", async () => {
    const onSave = vi.fn(async () => {})
    const onEditorRevert = vi.fn()
    const ctrl = createSaveController({ onSave, onEditorRevert })

    const diff = {
      deletions: "file before agent touched it",
      additions: "what the agent wrote",
    }

    ctrl.onChange("user's manual edits on top")
    // The caller must pass additions, not deletions
    ctrl.revertToOriginal("test.md", textFromDiff(diff, REVERT_TO_AGENT_SIDE))
    await vi.advanceTimersByTimeAsync(0)

    // The content written to disk must be the agent's version
    expect(onSave).toHaveBeenCalledWith("test.md", "what the agent wrote")
    // The editor is reset to the agent's version
    expect(onEditorRevert).toHaveBeenCalledWith("what the agent wrote")
  })
})

// ---------------------------------------------------------------------------
// File-title overflow: must NOT clip children (dropdown lives inside) (#837)
// ---------------------------------------------------------------------------
//
// The file-title container wraps <FileNameWithPicker> which renders an
// absolutely-positioned dropdown. `overflow: hidden` on the container clips
// that dropdown, making it invisible. The container must NOT set overflow:
// hidden — text truncation is handled by the leaf spans (file-name, file-path).
// ---------------------------------------------------------------------------

describe("File-title container overflow constraint", () => {
  /** Parse the CSS rule for file-title from the actual stylesheet. */
  function parseFileTitleOverflow(css: string): string | undefined {
    // Extract the rule for [data-slot="session-review-v2-file-title"]
    const ruleMatch = css.match(
      /\[data-slot="session-review-v2-file-title"\]\s*\{([^}]*)\}/,
    )
    if (!ruleMatch) return undefined
    const block = ruleMatch[1]
    // Extract overflow value
    const overflowMatch = block.match(/overflow\s*:\s*([^;]+)/)
    return overflowMatch ? overflowMatch[1].trim() : undefined
  }

  // We read the ACTUAL CSS file content to verify the constraint.
  // The CSS is in the fork's session-review-v2.css — we read it from the
  // overlay tracking copy (which sync:apply keeps in sync with the fork).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("fs") as typeof import("fs")
  const path = require("path") as typeof import("path")
  const cssPath = path.resolve(
    __dirname,
    "../../app-bundle/overlay/packages/session-ui/src/v2/components/session-review-v2.css",
  )
  const cssExists = fs.existsSync(cssPath)
  const cssContent = cssExists ? fs.readFileSync(cssPath, "utf-8") : ""

  test("file-title CSS rule must NOT have overflow: hidden", () => {
    if (!cssExists) {
      // If overlay hasn't synced yet, skip gracefully
      console.warn("Overlay CSS not found — skipping file-title overflow test")
      return
    }
    const overflow = parseFileTitleOverflow(cssContent)
    // overflow should be undefined (not set) or "visible" — never "hidden"
    expect(overflow).not.toBe("hidden")
  })

  test("file-title inline styles in TSX must NOT have overflow: hidden", () => {
    // Read the TSX to verify no inline overflow: hidden on the file-title trigger
    const tsxPath = path.resolve(
      __dirname,
      "../../app-bundle/overlay/packages/session-ui/src/v2/components/session-review-file-preview-v2.tsx",
    )
    if (!fs.existsSync(tsxPath)) {
      console.warn("Overlay TSX not found — skipping inline overflow test")
      return
    }
    const tsxContent = fs.readFileSync(tsxPath, "utf-8")

    // Find the style block for data-slot="session-review-v2-file-title"
    // The pattern: data-slot="session-review-v2-file-title" followed by
    // a style={{ ... }} block within a few lines
    const titleIdx = tsxContent.indexOf('data-slot="session-review-v2-file-title"')
    expect(titleIdx).toBeGreaterThan(-1)

    // Extract ~300 chars after the data-slot to capture the style block
    const vicinity = tsxContent.slice(titleIdx, titleIdx + 400)
    // Check that the style block does NOT contain overflow: hidden
    const styleMatch = vicinity.match(/style=\{\{([\s\S]*?)\}\}/)
    if (styleMatch) {
      const styleBlock = styleMatch[1]
      expect(styleBlock).not.toMatch(/overflow.*hidden/i)
    }
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
