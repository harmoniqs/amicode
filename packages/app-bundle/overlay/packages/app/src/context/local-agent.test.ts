import { describe, expect, test } from "bun:test"
import { hasAgentChoice, hasCustomAgent, resolveAgent } from "./local-agent"

describe("hasCustomAgent", () => {
  test("detects explicitly custom agents", () => {
    expect(hasCustomAgent([{ native: true }, { native: false }])).toBe(true)
  })

  test("ignores built-in and unclassified agents", () => {
    expect(hasCustomAgent([{ native: true }, {}])).toBe(false)
  })
})

describe("hasAgentChoice", () => {
  test("native plan/build alone IS a choice — the picker must show (#208)", () => {
    expect(hasAgentChoice([{ native: true, name: "plan" }, { native: true, name: "build" }])).toBe(true)
  })

  test("a single agent is not a choice — picker stays hidden (today's behavior)", () => {
    expect(hasAgentChoice([{ native: true, name: "build" }])).toBe(false)
    expect(hasAgentChoice([])).toBe(false)
  })

  test("a lone custom agent is still a choice (upstream behavior unchanged)", () => {
    expect(hasAgentChoice([{ native: false, name: "custom" }])).toBe(true)
  })
})

describe("resolveAgent", () => {
  const agents = [{ name: "plan" }, { name: "build" }, { name: "custom" }]

  test("uses the requested available agent", () => {
    expect(resolveAgent(agents, "custom")?.name).toBe("custom")
  })

  test("defaults to plan (plan → build → autodev → autoresearch ordering)", () => {
    expect(resolveAgent(agents)?.name).toBe("plan")
    expect(resolveAgent(agents, "missing")?.name).toBe("plan")
  })

  test("uses the first agent when build is unavailable", () => {
    expect(resolveAgent([{ name: "custom" }], "missing")?.name).toBe("custom")
  })
})
