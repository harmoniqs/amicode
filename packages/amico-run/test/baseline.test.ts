import { describe, it, expect } from "vitest"
import { maskFillPoints, maskedHash } from "../src/baseline.js"

const SCRIPT = `using Piccolo\n# ── FILL IN ──────\nT = 10.0\nN = 50\n# ─────────────────\nsolve()\n`

describe("maskedHash", () => {
  it("is edit-invariant inside fill points, sensitive outside", () => {
    const edited = SCRIPT.replace("T = 10.0", "T = 25.0")
    expect(maskedHash(SCRIPT)).toBe(maskedHash(edited))
    const physics = SCRIPT.replace("solve()", "solve!(hacked)")
    expect(maskedHash(SCRIPT)).not.toBe(maskedHash(physics))
  })
  it("custom markers override the defaults", () => {
    const custom = `a\n# BEGIN-KNOBS\nx = 1\n# END-KNOBS\nb\n`
    const edited = custom.replace("x = 1", "x = 999")
    expect(maskedHash(custom, "^# BEGIN-KNOBS", "^# END-KNOBS")).toBe(
      maskedHash(edited, "^# BEGIN-KNOBS", "^# END-KNOBS"),
    )
    // default markers don't match this file → edits are visible
    expect(maskedHash(custom)).not.toBe(maskedHash(edited))
  })
  it("an unterminated block masks to EOF", () => {
    const open = `head\n# ── FILL IN ──\nx = 1\ny = 2\n`
    const edited = open.replace("y = 2", "y = 3")
    expect(maskedHash(open)).toBe(maskedHash(edited))
    // but the head is still sensitive
    expect(maskedHash(open)).not.toBe(maskedHash(open.replace("head", "HEAD")))
  })
  it("the masked text keeps the marker lines and replaces interior lines", () => {
    const masked = maskFillPoints(SCRIPT)
    expect(masked).toContain("# ── FILL IN")
    expect(masked).toContain("# ─────")
    expect(masked).not.toContain("T = 10.0")
    expect(masked).toContain("#MASKED")
  })
})
