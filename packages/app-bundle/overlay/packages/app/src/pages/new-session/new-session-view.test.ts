import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// amicode#663 / #673 — the breadcrumb bar (project selector + workspace
// selector + git status) below the new-session composer. Originally gated on
// !inAmicode(), then un-gated (#663), then changed from selected() to empty()
// (#673) so the "Pick a project" placeholder is visible even when no project
// matches the draft directory.
const source = readFileSync(join(import.meta.dir, "new-session-view.tsx"), "utf8")

describe("project selector in new-session view (#663, #673)", () => {
  test("renders the selector when projects exist (not only when one is selected)", () => {
    // The guard must use !empty() (projects available), not selected() (one is matched)
    expect(source).toMatch(/props\.project\.empty\(\)/)
    expect(source).not.toMatch(/when=\{props\.project\.selected\(\)\}/)
  })
})
