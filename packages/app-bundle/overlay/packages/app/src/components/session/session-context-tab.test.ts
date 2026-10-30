import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// harmoniqs/amicode#627 — the context tab's "Total Cost" row showed an
// API-equivalent dollar figure that does not reflect what a seat-based Amicode
// user is charged. JSX is not renderable under bun, so guard the source (same
// static-guard pattern as message-part-css.test.ts).
const src = readFileSync(resolve(__dirname, "session-context-tab.tsx"), "utf8")

describe("context tab stats (#627)", () => {
  test("does not surface a total-cost stat row", () => {
    expect(src).not.toContain("context.stats.totalCost")
  })

  test("no dollar-formatting machinery is left behind for a removed cost row", () => {
    expect(src).not.toContain('currency: "USD"')
    expect(src).not.toContain("info()?.cost")
  })

  test("the remaining token/usage stats are untouched", () => {
    expect(src).toContain("context.stats.totalTokens")
    expect(src).toContain("context.stats.usage")
  })
})
