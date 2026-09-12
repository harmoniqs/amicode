import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// Regression guard for the bottom-anchored harmonic dot (replaces travelling
// dot #265). The running dot sits at the bottom of the last row — no position
// transitions needed, content grows above it.

const indexCss = readFileSync(resolve(__dirname, "../../../index.css"), "utf8")
const polishCss = readFileSync(resolve(__dirname, "../../../design-polish.css"), "utf8")

describe("bottom-anchored harmonic dot", () => {
  test("harmonic dot class has display:block (kills SVG baseline gap)", () => {
    expect(indexCss).toContain("thought-rail-dot--harmonic")
    expect(indexCss).toMatch(/thought-rail-dot--harmonic[^}]*display:\s*block/)
  })

  test("no position transition on the dot (bottom-anchored, passive)", () => {
    expect(indexCss).not.toContain("thought-rail-dot--settled")
  })

  test("no height transition on rail line (no travelling)", () => {
    expect(indexCss).not.toMatch(/thought-rail-line[^}]*transition[^}]*height/)
  })

  test("reduced motion disables SMIL animation", () => {
    expect(indexCss).toMatch(/prefers-reduced-motion[\s\S]*harmonic-dot-shape[\s\S]*display:\s*none/)
  })
})

describe("done-dot crossfade", () => {
  test("done-dot has an opacity transition (fade-in on completion)", () => {
    // The done-dot should fade in smoothly rather than appearing instantly.
    // Look for a CSS rule with transition containing "opacity" on the done state.
    expect(indexCss).toMatch(/thought-rail-dot[^}]*done[^}]*transition[^}]*opacity/)
  })
})

describe("timeline entrance animation", () => {
  test("timeline-enter keyframe uses blur + rise + opacity", () => {
    expect(polishCss).toMatch(/timeline-enter[\s\S]*opacity:\s*0/)
    expect(polishCss).toMatch(/timeline-enter[\s\S]*translateY/)
    expect(polishCss).toMatch(/timeline-enter[\s\S]*blur/)
  })

  test("[data-part-enter] uses timeline-enter (unified entrance)", () => {
    expect(polishCss).toMatch(/data-part-enter[\s\S]*timeline-enter/)
  })
})
