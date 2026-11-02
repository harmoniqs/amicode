import { describe, expect, test } from "bun:test"
import { linfit, percentile, wedgeEvents } from "./stats.ts"

describe("percentile (nearest rank)", () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1)
  test("known inputs", () => {
    expect(percentile(hundred, 50)).toBe(50)
    expect(percentile(hundred, 99)).toBe(99)
    expect(percentile(hundred, 100)).toBe(100)
    expect(percentile(hundred, 1)).toBe(1)
    expect(percentile([5], 99)).toBe(5)
    expect(percentile([1, 2, 3, 4], 50)).toBe(2)
  })
  test("does not need sorted input and does not mutate it", () => {
    const shuffled = [9, 1, 7, 3, 5]
    expect(percentile(shuffled, 100)).toBe(9)
    expect(percentile(shuffled, 20)).toBe(1)
    expect(shuffled).toEqual([9, 1, 7, 3, 5])
  })
  test("empty input is NaN, never a number that could pass a threshold", () => {
    expect(percentile([], 99)).toBeNaN()
  })
})

describe("wedgeEvents: two consecutive misses are one event", () => {
  const run = (pattern: string) => wedgeEvents([...pattern].map((c, i) => ({ t: i * 250, miss: c === "x" })))
  test("no samples, no misses, one miss: zero events", () => {
    expect(run("").count).toBe(0)
    expect(run("....").count).toBe(0)
    expect(run("..x..").count).toBe(0)
  })
  test("two consecutive misses: one event", () => {
    expect(run("..xx..").count).toBe(1)
  })
  test("a long outage is still one event, with its extent", () => {
    const result = run("..xxxxx..")
    expect(result.count).toBe(1)
    expect(result.events[0]).toMatchObject({ start: 2 * 250, end: 6 * 250, misses: 5 })
  })
  test("recovery resets the count: miss, ok, miss is not a wedge", () => {
    expect(run("x.x.x").count).toBe(0)
  })
  test("separate outages are separate events", () => {
    expect(run("xx..xx..xxx").count).toBe(3)
  })
  test("an outage still open at the end counts", () => {
    expect(run("..xx").count).toBe(1)
  })
  test("sorts by time first", () => {
    const shuffled = [
      { t: 750, miss: false },
      { t: 250, miss: true },
      { t: 500, miss: true },
      { t: 0, miss: false },
    ]
    expect(wedgeEvents(shuffled).count).toBe(1)
  })
})

describe("linfit", () => {
  test("recovers an exact line", () => {
    const fit = linfit(Array.from({ length: 10 }, (_, i) => ({ x: i, y: 5 + 2 * i })))
    expect(fit.slope).toBeCloseTo(2, 9)
    expect(fit.intercept).toBeCloseTo(5, 9)
  })
  test("flat data has zero slope", () => {
    expect(linfit([{ x: 0, y: 7 }, { x: 1, y: 7 }, { x: 2, y: 7 }]).slope).toBe(0)
  })
  test("fewer than two distinct x is undefined, not zero", () => {
    expect(linfit([{ x: 1, y: 1 }]).slope).toBeNaN()
    expect(linfit([{ x: 1, y: 1 }, { x: 1, y: 3 }]).slope).toBeNaN()
  })
})
