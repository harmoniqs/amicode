import { describe, expect, test } from "bun:test"
import { smoothScrollInterpolate } from "./smooth-scroll"

describe("smoothScrollInterpolate", () => {
  test("returns startY at elapsed=0", () => {
    expect(smoothScrollInterpolate(100, 500, 0, 180)).toBe(100)
  })

  test("returns targetY when elapsed >= duration", () => {
    expect(smoothScrollInterpolate(100, 500, 180, 180)).toBe(500)
    expect(smoothScrollInterpolate(100, 500, 300, 180)).toBe(500)
  })

  test("returns intermediate value at 50% elapsed", () => {
    const mid = smoothScrollInterpolate(0, 400, 90, 180)
    // Ease-out cubic at t=0.5: 1 - (1 - 0.5)^3 = 1 - 0.125 = 0.875
    expect(mid).toBe(400 * 0.875)
  })

  test("is monotonically increasing for scrolling down", () => {
    let prev = 0
    for (let t = 0; t <= 180; t += 10) {
      const current = smoothScrollInterpolate(0, 1000, t, 180)
      expect(current).toBeGreaterThanOrEqual(prev)
      prev = current
    }
  })

  test("handles scrolling up (target < start)", () => {
    const result = smoothScrollInterpolate(500, 100, 180, 180)
    expect(result).toBe(100)
    const mid = smoothScrollInterpolate(500, 100, 90, 180)
    expect(mid).toBeLessThan(500)
    expect(mid).toBeGreaterThan(100)
  })

  test("clamps to targetY for very large elapsed values", () => {
    expect(smoothScrollInterpolate(0, 1000, 99999, 180)).toBe(1000)
  })
})
