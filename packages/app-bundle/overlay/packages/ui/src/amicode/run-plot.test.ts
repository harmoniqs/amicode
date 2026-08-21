import { describe, expect, test } from "bun:test"
import { drivePaths, heroPaths, linePath, objectivePath, scaledPath } from "./run-plot"

describe("scaledPath / linePath", () => {
  test("maps points into the box, M then L", () => {
    const d = scaledPath([0, 1], 0, 1, 100, 34)
    expect(d).toBe("M0.00,32.00 L100.00,2.00")
  })
  test("flat series does not divide by zero", () => {
    expect(scaledPath([5, 5], 5, 5, 100, 34)).toContain("M0.00,")
  })
  test("linePath needs ≥2 points", () => {
    expect(linePath([1], 100, 34)).toBeUndefined()
    expect(linePath([1, 2], 100, 34)).toBeDefined()
  })
})

describe("objectivePath", () => {
  test("log-scales and clamps non-positive values", () => {
    expect(objectivePath([80.3, 1e-3], 100, 34)).toBeDefined()
    expect(objectivePath([1, 0], 100, 34)).toBeDefined() // 0 → 1e-12 clamp, no NaN
    expect(objectivePath([1], 100, 34)).toBeUndefined()
  })
})

describe("drivePaths", () => {
  test("slices flattened drives on a shared scale", () => {
    const paths = drivePaths([0, 1, 2, 10, 11, 12], 2, 100, 34)
    expect(paths).toHaveLength(2)
    // shared min/max: first drive occupies the low band, second the high band
    expect(paths[0]).not.toBe(paths[1])
  })
  test("fewer than 2 knots per drive → no paths", () => {
    expect(drivePaths([1, 2], 3, 100, 34)).toEqual([])
  })
})

describe("heroPaths (pulse-first selection)", () => {
  const series = [
    { iter: 0, f: 80.3 },
    { iter: 1, f: 1e-3 },
  ]
  test("prefers the pulse when a snapshot exists", () => {
    const paths = heroPaths({ series, pulse: { values: [0, 1, 2, 3] }, pulseMeta: { drives: 2 } }, 100, 34)
    expect(paths).toHaveLength(2)
  })
  test("falls back to the convergence curve without a pulse", () => {
    expect(heroPaths({ series, pulse: null, pulseMeta: null }, 100, 34)).toHaveLength(1)
  })
  test("nothing at all → empty", () => {
    expect(heroPaths({ series: [], pulse: null, pulseMeta: null }, 100, 34)).toEqual([])
  })
})
