import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// amicode#612 — both composers mount the shared drag-to-resize handle and
// apply the persisted height to the text area. Source-structure checks, in the
// same style as prompt-input-clipboard-structure.test.ts: the behavior itself
// is covered in session-ui's resize.test.ts, this pins the wiring.
const v1 = readFileSync(join(import.meta.dir, "prompt-input.tsx"), "utf8")
const v2 = readFileSync(
  join(import.meta.dir, "../../../session-ui/src/v2/components/prompt-input/index.tsx"),
  "utf8",
)
const handle = readFileSync(
  join(import.meta.dir, "../../../session-ui/src/v2/components/prompt-input/resize-handle.tsx"),
  "utf8",
)

describe("composer drag-to-resize wiring (#612)", () => {
  test("the legacy composer mounts the handle and pins the scroller height from it", () => {
    expect(v1).toContain("<ComposerResizeHandle")
    expect(v1).toContain("createComposerResize(")
    expect(v1).toContain("resize.height()")
  })

  test("the v2 composer mounts the handle and pins the editor height from it", () => {
    expect(v2).toContain("<ComposerResizeHandle")
    expect(v2).toContain("createComposerResize(")
    expect(v2).toContain("composerHeightStyle(resize.height())")
  })

  test("the handle is an accessible, keyboard-operable horizontal separator", () => {
    expect(handle).toContain('role="separator"')
    expect(handle).toContain('aria-orientation="horizontal"')
    expect(handle).toContain('tabindex="0"')
    expect(handle).toContain("onKeyDown")
    expect(handle).toContain("onDblClick")
  })
})
