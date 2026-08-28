import { describe, expect, test } from "bun:test"
import { dotCentreForGroup, type TimelineGroupType } from "./dot-offsets"

describe("dotCentreForGroup", () => {
  test("prose group returns 21px", () => {
    expect(dotCentreForGroup("prose")).toBe(21)
  })

  test("tool-group returns 11px", () => {
    expect(dotCentreForGroup("tool-group")).toBe(11)
  })

  test("single-tool returns 16px", () => {
    expect(dotCentreForGroup("single-tool")).toBe(16)
  })

  test("thinking returns 11px", () => {
    expect(dotCentreForGroup("thinking")).toBe(11)
  })

  test("unknown type falls back to prose offset", () => {
    expect(dotCentreForGroup("unknown" as TimelineGroupType)).toBe(21)
  })

  test("all offsets are positive numbers", () => {
    const types: TimelineGroupType[] = ["prose", "tool-group", "single-tool", "thinking"]
    for (const t of types) {
      const offset = dotCentreForGroup(t)
      expect(offset).toBeGreaterThan(0)
      expect(typeof offset).toBe("number")
    }
  })
})
