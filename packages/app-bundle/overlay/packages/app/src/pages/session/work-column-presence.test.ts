import { describe, expect, test } from "bun:test"
import {
  reduceWorkColumnPhase,
  WORK_COLUMN_TRANSITION_EASING,
  WORK_COLUMN_TRANSITION_MS,
  workColumnExpanded,
  workColumnMounted,
  workColumnTransitioning,
  type WorkColumnPhase,
} from "./work-column-presence"

describe("reduceWorkColumnPhase", () => {
  test("collapse animates through closing before unmounting", () => {
    let phase: WorkColumnPhase = "open"
    phase = reduceWorkColumnPhase(phase, "hide")
    expect(phase).toBe("closing")
    expect(workColumnMounted(phase)).toBe(true)
    expect(workColumnExpanded(phase)).toBe(false)
    phase = reduceWorkColumnPhase(phase, "settled")
    expect(phase).toBe("unmounted")
    expect(workColumnMounted(phase)).toBe(false)
  })

  test("restore mounts collapsed, then expands once settled", () => {
    let phase: WorkColumnPhase = "unmounted"
    phase = reduceWorkColumnPhase(phase, "show")
    expect(phase).toBe("opening")
    expect(workColumnMounted(phase)).toBe(true)
    expect(workColumnExpanded(phase)).toBe(false)
    phase = reduceWorkColumnPhase(phase, "settled")
    expect(phase).toBe("open")
    expect(workColumnExpanded(phase)).toBe(true)
  })

  test("reversing mid-animation keeps the column mounted and retargets", () => {
    expect(reduceWorkColumnPhase("opening", "hide")).toBe("closing")
    expect(reduceWorkColumnPhase("closing", "show")).toBe("opening")
  })

  test("events that do not apply to the current phase are no-ops", () => {
    expect(reduceWorkColumnPhase("open", "show")).toBe("open")
    expect(reduceWorkColumnPhase("unmounted", "hide")).toBe("unmounted")
    expect(reduceWorkColumnPhase("unmounted", "settled")).toBe("unmounted")
    expect(reduceWorkColumnPhase("open", "settled")).toBe("open")
  })
})

describe("transition constants", () => {
  test("uses a ~200ms ease-out style curve, not linear", () => {
    expect(WORK_COLUMN_TRANSITION_MS).toBe(200)
    expect(WORK_COLUMN_TRANSITION_EASING).toBe("cubic-bezier(0.22,1,0.36,1)")
  })
})

describe("workColumnTransitioning", () => {
  test("is true only while opening or closing", () => {
    expect(workColumnTransitioning("opening")).toBe(true)
    expect(workColumnTransitioning("closing")).toBe(true)
    expect(workColumnTransitioning("open")).toBe(false)
    expect(workColumnTransitioning("unmounted")).toBe(false)
  })
})
