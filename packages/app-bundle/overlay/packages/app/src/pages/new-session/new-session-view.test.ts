import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// amicode#326 — the breadcrumb bar (project selector + workspace selector +
// git status) below the new-session composer must be hidden when running inside
// the Amicode webview. Sessions already scope to all workspace folders via the
// multi-directory engine (opencode#215), so the bar is redundant chrome.
//
// Source assertion: the view must gate the breadcrumb section on !inAmicode().
// No component-render harness exists (no @solidjs/testing-library), so we
// verify structurally — the same pattern as prompt-input-clipboard-structure.test.ts.
const source = readFileSync(join(import.meta.dir, "new-session-view.tsx"), "utf8")

describe("breadcrumb bar hidden in Amicode (amicode#326)", () => {
  test("imports inAmicode", () => {
    expect(source).toContain("inAmicode")
  })

  test("the project-selected breadcrumb block is gated on !inAmicode()", () => {
    // The breadcrumb row renders inside a <Show when={...project.selected()}>
    // that must also check !inAmicode(). We verify both conditions appear
    // together in the guard.
    expect(source).toMatch(/!inAmicode\(\).*project\.selected\(\)/)
  })
})
