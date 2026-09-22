import { test, expect, describe } from "bun:test"
import { clampVisibleLine, anchoredScrollTop, initialHidden } from "./preview-editor-helpers"

// #1414 (CodeRabbit, Major·Correctness): an external content reload restored the
// CURSOR line, so if the user had scrolled away from the cursor the view jumped.
// Restore the FIRST VISIBLE line at its captured viewport offset instead.
describe("clampVisibleLine", () => {
  test("clamps the first-visible line to the new document's line count", () => {
    expect(clampVisibleLine(80, 40)).toBe(40)
  })

  test("leaves an in-range line unchanged", () => {
    expect(clampVisibleLine(10, 100)).toBe(10)
  })

  test("floors sub-1 to line 1", () => {
    expect(clampVisibleLine(0, 40)).toBe(1)
  })
})

describe("anchoredScrollTop", () => {
  test("re-applies the captured viewport offset to the new line-block top", () => {
    expect(anchoredScrollTop(500, -30)).toBe(470)
  })

  test("never returns a negative scrollTop", () => {
    expect(anchoredScrollTop(10, -50)).toBe(0)
  })
})

// #1414 (CodeRabbit, Major·Correctness): `hidden` initialised to false ignored an
// inactive mount, letting capture listeners persist a collapsed scroll position
// before activation.
describe("initialHidden", () => {
  test("is hidden when mounted inactive", () => {
    expect(initialHidden(() => false)).toBe(true)
  })

  test("is visible when mounted active", () => {
    expect(initialHidden(() => true)).toBe(false)
  })

  test("is visible when there is no active gate", () => {
    expect(initialHidden(undefined)).toBe(false)
  })
})
