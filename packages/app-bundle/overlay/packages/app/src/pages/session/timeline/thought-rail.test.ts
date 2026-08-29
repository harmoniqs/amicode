import { describe, expect, test } from "bun:test"
import { shouldRenderRail } from "./thought-rail"

// The rail's grammar, stated as tests. A step is "running" only when it is the
// TAIL of a turn that is still working; everything above it has by definition
// been succeeded. That is what guarantees a hollow dot can never sit above a
// filled one, however the underlying tools complete.
const railState = (row: { previousAssistantPart: boolean; lastAssistantPart: boolean; turnRunning: boolean }) => ({
  render: shouldRenderRail(row),
  first: !row.previousAssistantPart,
  last: row.lastAssistantPart,
  running: row.lastAssistantPart && row.turnRunning,
})

/** Build the rows a turn of `n` steps produces, mirroring rows.ts. */
const turn = (n: number, running: boolean) =>
  Array.from({ length: n }, (_, i) =>
    railState({ previousAssistantPart: i > 0, lastAssistantPart: i === n - 1, turnRunning: running }),
  )

describe("thought rail", () => {
  test("a finished single-step turn still renders a rail — Thinking row above provides the sequence", () => {
    expect(turn(1, false)[0].render).toBe(true)
  })

  test("a RUNNING turn rails from its very first step — the live dot is the only working mark", () => {
    const step = turn(1, true)[0]
    expect(step.render).toBe(true)
    expect(step.running).toBe(true)
    // first && last: the lone live dot carries no line, so nothing visibly
    // retracts when a one-step turn completes — the dot fills, then yields
    expect(step.first && step.last).toBe(true)
  })

  test("a multi-step turn draws a rail on every step", () => {
    expect(turn(4, false).every((s) => s.render)).toBe(true)
  })

  test("exactly one dot is running, and it is the tail", () => {
    const steps = turn(5, true)
    const running = steps.filter((s) => s.running)
    expect(running).toHaveLength(1)
    expect(steps[steps.length - 1].running).toBe(true)
  })

  test("no dot is running once the turn finishes — the tail fills too", () => {
    expect(turn(5, false).some((s) => s.running)).toBe(false)
  })

  test("a hollow dot never sits above a filled one, at any length", () => {
    for (const n of [2, 3, 7, 20]) {
      const steps = turn(n, true)
      const firstRunning = steps.findIndex((s) => s.running)
      // everything after the running step must not exist; it is the tail
      expect(firstRunning).toBe(n - 1)
      expect(steps.slice(0, firstRunning).some((s) => s.running)).toBe(false)
    }
  })

  test("first and last are flagged so the line does not overshoot either end", () => {
    const steps = turn(3, false)
    expect(steps.map((s) => s.first)).toEqual([true, false, false])
    expect(steps.map((s) => s.last)).toEqual([false, false, true])
  })
})
