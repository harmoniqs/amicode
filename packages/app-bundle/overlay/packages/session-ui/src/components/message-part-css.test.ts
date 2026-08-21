import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// Regression guard: the text-card (kind:"text") CSS was accidentally deleted
// once (amicode#349 / opencode#121) during a file-reference feature refactor.
// Without these rules the textarea in a free-form question is transparent and
// borderless — effectively invisible. This test catches a future deletion.

const css = readFileSync(resolve(__dirname, "message-part.css"), "utf8")

describe("question text-card CSS (amicode#349 regression)", () => {
  test("question-text-form selector is present", () => {
    expect(css).toContain('[data-slot="question-text-form"]')
  })

  test("text-form textarea has visible border", () => {
    expect(css).toContain('[data-slot="question-text-form"] > [data-slot="question-custom-input"]')
  })

  test("text-form textarea has min-height", () => {
    expect(css).toContain("min-height: 36px")
  })

  test("text-form textarea has background", () => {
    // The v2 design token path
    expect(css).toMatch(/question-text-form.*background.*bg-layer-02/s)
  })
})
