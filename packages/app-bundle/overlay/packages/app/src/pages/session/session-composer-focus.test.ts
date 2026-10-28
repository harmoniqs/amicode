import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// #1248 structural ACs — composer refocus + caret restore on session tab switch.
//
// Root cause: the existing params.id effect only focused when id was falsy (the
// draft / landing view). Clicking a tab button stole focus and nothing put it
// back on the composer. The caret was also not preserved per session because the
// selectionchange listener was absent.
//
// These ACs are locked as source-level guards against regression on the next
// upstream merge. The same pattern is used by session-side-panel-structure.test.ts
// and use-composer-commands.test.ts for stable, no-runtime checks.

const SRC = readFileSync(join(import.meta.dir, "../session.tsx"), "utf-8")

describe("composer refocus on session tab switch (#1248)", () => {
  test("getCursorPosition is imported alongside setCursorPosition", () => {
    expect(SRC).toContain("getCursorPosition")
    expect(SRC).toMatch(/import\s*\{[^}]*getCursorPosition[^}]*\}\s*from/)
  })

  test("params.id effect refocuses when switching to a new session (id !== prev branch)", () => {
    // The fix must handle the id !== prev case, not just the !id case.
    expect(SRC).toContain("id !== prev")
  })

  test("refocus path calls input.focus() in the rAF callback for a tab switch", () => {
    // The fix uses a requestAnimationFrame guard (same as the draft branch) so
    // the focus fires AFTER the tab button's blur propagates.
    const rafBlock = SRC.indexOf("id !== prev")
    expect(rafBlock).toBeGreaterThan(-1)
    const surroundingSlice = SRC.slice(rafBlock, rafBlock + 400)
    expect(surroundingSlice).toContain("requestAnimationFrame")
    expect(surroundingSlice).toContain("input.focus()")
  })

  test("refocus path restores saved caret (sessionCaretOffsets.get)", () => {
    expect(SRC).toContain("sessionCaretOffsets.get(id)")
  })

  test("selectionchange listener is registered on document", () => {
    expect(SRC).toContain(`"selectionchange"`)
    expect(SRC).toContain("onComposerSelectionChange")
  })

  test("selectionchange listener is cleaned up on component unmount", () => {
    // Must be inside an onCleanup so it doesn't leak on session page unmount.
    expect(SRC).toContain("removeEventListener(\"selectionchange\", onComposerSelectionChange)")
  })

  test("per-session caret map is declared as a Map keyed by session ID", () => {
    expect(SRC).toContain("sessionCaretOffsets")
    expect(SRC).toContain("new Map<string, number>()")
  })

  test("selectionchange handler guards on inputRef ownership before saving position", () => {
    // Must not capture position from any other contenteditable on the page.
    expect(SRC).toContain("input.contains(document.activeElement)")
  })
})
