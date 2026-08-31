import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// amicode#663 — the breadcrumb bar (project selector + workspace selector +
// git status) below the new-session composer is now SHOWN in the Amicode
// webview, enriched with type grouping (Research/Dev). The !inAmicode() gate
// was removed in #667 (Selector UI enrichment).
const source = readFileSync(join(import.meta.dir, "new-session-view.tsx"), "utf8")

describe("breadcrumb bar shown in Amicode (#663, #667)", () => {
  test("no longer imports inAmicode (gate removed)", () => {
    expect(source).not.toContain("inAmicode")
  })

  test("the project-selected breadcrumb block is NOT gated on !inAmicode()", () => {
    expect(source).not.toMatch(/!inAmicode\(\)/)
  })
})
