import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// Regression guard for the travelling dot + bottom-up card animation (#265).
// These CSS declarations are load-bearing: removing them silently breaks the
// dot's smooth travel and the card entry motion.

const indexCss = readFileSync(resolve(__dirname, "../../../index.css"), "utf8")
const polishCss = readFileSync(resolve(__dirname, "../../../design-polish.css"), "utf8")

describe("travelling dot transition (#265)", () => {
  test("settled dot has top transition", () => {
    expect(indexCss).toContain("thought-rail-dot--settled")
    expect(indexCss).toMatch(/thought-rail-dot--settled[^}]*transition[^}]*top/)
  })

  test("rail line has height transition", () => {
    expect(indexCss).toMatch(/thought-rail-line[^}]*transition[^}]*height/)
  })

  test("reduced motion disables dot transition", () => {
    // Inside a prefers-reduced-motion block, the settled class gets transition: none
    expect(indexCss).toMatch(/prefers-reduced-motion[\s\S]*thought-rail-dot--settled[\s\S]*transition:\s*none/)
  })

  test("reduced motion disables rail line transition", () => {
    expect(indexCss).toMatch(/prefers-reduced-motion[\s\S]*thought-rail-line[\s\S]*transition:\s*none/)
  })
})

describe("prose fragment entry animation (#265)", () => {
  test("prose-fragment-enter keyframe exists", () => {
    expect(polishCss).toContain("prose-fragment-enter")
  })

  test("prose-fragment-enter uses translateY", () => {
    expect(polishCss).toMatch(/prose-fragment-enter[\s\S]*translateY\(10px\)/)
  })

  test("prose-fragment cards use prose-fragment-enter animation", () => {
    expect(polishCss).toMatch(/data-prose-fragment.*data-part-enter[\s\S]*prose-fragment-enter/)
  })

  test("prose-fragment-enter has 150ms duration", () => {
    expect(polishCss).toMatch(/data-prose-fragment.*data-part-enter[\s\S]*150ms/)
  })

  test("reduced motion disables prose-fragment entrance", () => {
    expect(polishCss).toMatch(/prefers-reduced-motion[\s\S]*data-prose-fragment.*data-part-enter[\s\S]*animation:\s*none/)
  })
})
