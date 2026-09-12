import { describe, expect, test } from "bun:test"
import { splitCountLabel } from "./tool-count-label"

describe("splitCountLabel", () => {
  test("returns an empty label when a translation is missing", () => {
    expect(splitCountLabel()).toEqual({ before: "", after: "" })
  })
})
