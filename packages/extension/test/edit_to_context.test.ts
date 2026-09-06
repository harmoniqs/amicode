import { describe, expect, test, vi } from "vitest"

/**
 * Tests for #771: Edit-to-context feedback system.
 *
 * Tests the edit context manager that tracks per-file edit snapshots
 * and produces diff context items for the agent.
 */

// ---------------------------------------------------------------------------
// Simple line diff for tests (the real impl uses the `diff` npm package)
// ---------------------------------------------------------------------------

function simpleDiff(path: string, original: string, current: string): string {
  const origLines = original.split("\n")
  const currLines = current.split("\n")
  const lines: string[] = [`--- ${path}\t(original)`, `+++ ${path}\t(edited)`, "@@ diff @@"]
  const maxLen = Math.max(origLines.length, currLines.length)
  for (let i = 0; i < maxLen; i++) {
    const o = i < origLines.length ? origLines[i] : undefined
    const c = i < currLines.length ? currLines[i] : undefined
    if (o === c) {
      lines.push(` ${o}`)
    } else {
      if (o !== undefined) lines.push(`-${o}`)
      if (c !== undefined) lines.push(`+${c}`)
    }
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Edit context manager
// ---------------------------------------------------------------------------

interface EditContextItem {
  type: "file"
  path: string
  comment: string
  commentID: string
  commentOrigin: "review"
}

function createEditContextManager() {
  const snapshots = new Map<string, string>() // path → original content
  const items = new Map<string, EditContextItem>() // path → context item

  return {
    get size() {
      return items.size
    },

    /**
     * Record a file's original content (snapshot taken on first edit).
     */
    snapshot(path: string, originalContent: string) {
      if (!snapshots.has(path)) {
        snapshots.set(path, originalContent)
      }
    },

    /**
     * Update the edit context for a file with its current content.
     * Produces a unified diff between original and current.
     */
    update(path: string, currentContent: string) {
      const original = snapshots.get(path)
      if (original === undefined) return

      // If content matches original, remove the context item
      if (original === currentContent) {
        items.delete(path)
        return
      }

      const diff = simpleDiff(path, original, currentContent)
      const comment = `The user made the following edits to ${path}:\n\n${diff}`

      items.set(path, {
        type: "file",
        path,
        comment,
        commentID: `edit:${path}`,
        commentOrigin: "review",
      })
    },

    /**
     * Get context items for message send.
     */
    getItems(): EditContextItem[] {
      return Array.from(items.values())
    },

    /**
     * Clear a single file's edit context (e.g., on revert).
     */
    clearFile(path: string) {
      items.delete(path)
      snapshots.delete(path)
    },

    /**
     * Consume all items (remove after send).
     */
    consumeAll(): EditContextItem[] {
      const result = Array.from(items.values())
      items.clear()
      snapshots.clear()
      return result
    },

    /**
     * Check if a file has pending edits.
     */
    hasEdits(path: string): boolean {
      return items.has(path)
    },
  }
}

describe("Edit context manager", () => {
  test("starts empty", () => {
    const mgr = createEditContextManager()
    expect(mgr.size).toBe(0)
    expect(mgr.getItems()).toEqual([])
  })

  test("first edit creates a snapshot and context item", () => {
    const mgr = createEditContextManager()
    mgr.snapshot("src/foo.ts", "original")
    mgr.update("src/foo.ts", "modified")

    expect(mgr.size).toBe(1)
    const items = mgr.getItems()
    expect(items.length).toBe(1)
    expect(items[0].path).toBe("src/foo.ts")
    expect(items[0].commentOrigin).toBe("review")
    expect(items[0].comment).toContain("The user made the following edits to src/foo.ts")
    expect(items[0].comment).toContain("original")
    expect(items[0].comment).toContain("modified")
  })

  test("continued edits update the same item (one per file)", () => {
    const mgr = createEditContextManager()
    mgr.snapshot("src/foo.ts", "original")
    mgr.update("src/foo.ts", "edit-v1")
    mgr.update("src/foo.ts", "edit-v2")

    expect(mgr.size).toBe(1)
    const items = mgr.getItems()
    expect(items[0].comment).toContain("edit-v2")
    expect(items[0].comment).not.toContain("edit-v1")
  })

  test("editing back to original removes the item", () => {
    const mgr = createEditContextManager()
    mgr.snapshot("src/foo.ts", "original")
    mgr.update("src/foo.ts", "modified")
    expect(mgr.size).toBe(1)

    mgr.update("src/foo.ts", "original")
    expect(mgr.size).toBe(0)
  })

  test("multiple files each get their own item", () => {
    const mgr = createEditContextManager()
    mgr.snapshot("a.ts", "orig-a")
    mgr.snapshot("b.ts", "orig-b")
    mgr.update("a.ts", "mod-a")
    mgr.update("b.ts", "mod-b")

    expect(mgr.size).toBe(2)
    const paths = mgr.getItems().map((i) => i.path).sort()
    expect(paths).toEqual(["a.ts", "b.ts"])
  })

  test("clearFile removes snapshot and item for one file", () => {
    const mgr = createEditContextManager()
    mgr.snapshot("a.ts", "orig")
    mgr.update("a.ts", "mod")
    mgr.snapshot("b.ts", "orig")
    mgr.update("b.ts", "mod")

    mgr.clearFile("a.ts")
    expect(mgr.size).toBe(1)
    expect(mgr.hasEdits("a.ts")).toBe(false)
    expect(mgr.hasEdits("b.ts")).toBe(true)
  })

  test("consumeAll returns items and clears everything", () => {
    const mgr = createEditContextManager()
    mgr.snapshot("a.ts", "orig")
    mgr.update("a.ts", "mod")

    const consumed = mgr.consumeAll()
    expect(consumed.length).toBe(1)
    expect(mgr.size).toBe(0)
    expect(mgr.getItems()).toEqual([])
  })

  test("snapshot only records on first call (doesn't overwrite)", () => {
    const mgr = createEditContextManager()
    mgr.snapshot("a.ts", "first-original")
    mgr.snapshot("a.ts", "second-original")
    mgr.update("a.ts", "modified")

    const items = mgr.getItems()
    // The diff should be against "first-original", not "second-original"
    expect(items[0].comment).toContain("first-original")
  })

  test("context items have unique commentIDs per file", () => {
    const mgr = createEditContextManager()
    mgr.snapshot("a.ts", "o")
    mgr.snapshot("b.ts", "o")
    mgr.update("a.ts", "m")
    mgr.update("b.ts", "m")

    const ids = mgr.getItems().map((i) => i.commentID)
    expect(new Set(ids).size).toBe(2)
    expect(ids).toContain("edit:a.ts")
    expect(ids).toContain("edit:b.ts")
  })

  test("hasEdits returns false for unknown files", () => {
    const mgr = createEditContextManager()
    expect(mgr.hasEdits("unknown.ts")).toBe(false)
  })

  test("context item comment contains unified diff format", () => {
    const mgr = createEditContextManager()
    mgr.snapshot("file.ts", "line1\nline2\nline3\n")
    mgr.update("file.ts", "line1\nline2-changed\nline3\nline4\n")

    const items = mgr.getItems()
    // Should contain diff markers
    expect(items[0].comment).toContain("---")
    expect(items[0].comment).toContain("+++")
    expect(items[0].comment).toContain("@@")
  })
})
