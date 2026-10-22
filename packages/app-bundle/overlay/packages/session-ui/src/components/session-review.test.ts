import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// #1841 — reported live 2026-10-22: clicking the file rows in session output
// (the review accordion — "files next to edit") did nothing at all. Root cause:
// BOTH the row's open-file affordance and its trigger were gated on
// diffCanRender() (additions/deletions !== 0) — any file whose live summary
// carries no line counts rendered a disabled native button with no open-file
// button, a dead row by construction (Kobalte's disabled trigger swallows
// descendant clicks). Opening a file requires no renderable diff.
// Source assertions per the repo's component-source-assertion convention.
describe("session-review file rows are openable regardless of diff renderability (#1841)", () => {
  const source = readFileSync(resolve(__dirname, "session-review.tsx"), "utf8")

  test("the open-file affordance is not gated on diffCanRender", () => {
    expect(source).not.toContain("onViewFile && diffCanRender()")
  })

  test("the trigger stays enabled whenever an open-file handler exists", () => {
    expect(source).toContain("disabled={!diffCanRender() && !props.onViewFile}")
  })
})
