import { test, expect, describe } from "bun:test"
import { clampRestorePage } from "./pdf-restore"

// #1414 (CodeRabbit, Major·Correctness): a restored page target must be clamped
// to the loaded PDF's page count. When a regenerated PDF has FEWER pages than
// the saved target, the un-clamped target can never match a page anchor, so the
// restore never completes and currentPage stays out of range.
describe("clampRestorePage", () => {
  test("clamps a target beyond the page count down to the last page", () => {
    expect(clampRestorePage(9, 3)).toBe(3)
  })

  test("leaves an in-range target unchanged", () => {
    expect(clampRestorePage(2, 5)).toBe(2)
  })

  test("preserves the target while the page count is still unknown (0)", () => {
    expect(clampRestorePage(5, 0)).toBe(5)
  })

  test("floors sub-1 targets to page 1", () => {
    expect(clampRestorePage(0, 5)).toBe(1)
  })
})
