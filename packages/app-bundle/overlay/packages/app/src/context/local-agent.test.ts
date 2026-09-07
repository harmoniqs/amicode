import { describe, expect, test } from "bun:test"
import { hasAgentChoice, hasCustomAgent, resolveAgent, orderByPickerConfig, impliedAgent, isImpliedAgent } from "./local-agent"

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

  test("defaults to build", () => {
    expect(resolveAgent(agents)?.name).toBe("build")
    expect(resolveAgent(agents, "missing")?.name).toBe("build")
  })

  test("uses the first agent when build is unavailable", () => {
    expect(resolveAgent([{ name: "custom" }], "missing")?.name).toBe("custom")
  })

  test("resolves the old director ids through the read-resolve alias (#858)", () => {
    const renamed = [{ name: "plan" }, { name: "develop" }, { name: "research" }, { name: "build" }]
    expect(resolveAgent(renamed, "autodev")?.name).toBe("develop")
    expect(resolveAgent(renamed, "autoresearch")?.name).toBe("research")
    // build stays valid — it exits the picker, not the vocabulary
    expect(resolveAgent(renamed, "build")?.name).toBe("build")
  })
})

describe("orderByPickerConfig (#858 — the fixed order plan → develop → research, #305 semantics)", () => {
  const agents = [{ name: "research" }, { name: "build" }, { name: "plan" }, { name: "develop" }, { name: "custom" }]

  test("agent_order is the PRIMARY sort key — listed agents in declared order, unlisted after", () => {
    const out = orderByPickerConfig(agents, { agent_order: ["plan", "develop", "research"] })
    expect(out.map((a) => a.name)).toEqual(["plan", "develop", "research", "build", "custom"])
  })

  test("unlisted agents keep their server order beneath the listed ones; the implicit build pin + alphabetical order them", () => {
    const out = orderByPickerConfig(
      [{ name: "zeta" }, { name: "build" }, { name: "alpha" }, { name: "plan" }],
      { agent_order: ["plan"] },
    )
    // build is the implicit default pin (#305's fallback) — it leads the
    // unlisted block; alpha/zeta follow alphabetically
    expect(out.map((a) => a.name)).toEqual(["plan", "build", "alpha", "zeta"])
  })

  test("the default_agent pin is the secondary key among the unlisted (#305 precedence)", () => {
    const out = orderByPickerConfig(
      [{ name: "zeta" }, { name: "build" }, { name: "alpha" }],
      { agent_order: ["plan"], default_agent: "zeta" },
    )
    expect(out.map((a) => a.name)).toEqual(["zeta", "alpha", "build"])
  })

  test("no agent_order config falls back to the incoming order unchanged (stock behavior)", () => {
    expect(orderByPickerConfig(agents, {}).map((a) => a.name)).toEqual([
      "research",
      "build",
      "plan",
      "develop",
      "custom",
    ])
    expect(orderByPickerConfig(agents, undefined).map((a) => a.name)).toEqual([
      "research",
      "build",
      "plan",
      "develop",
      "custom",
    ])
  })

  test("an agent_order entry naming no shipped agent is inert", () => {
    const out = orderByPickerConfig(agents, { agent_order: ["plan", "ghost", "develop", "research"] })
    expect(out.map((a) => a.name)).toEqual(["plan", "develop", "research", "build", "custom"])
  })
})

describe("the implied posture marker (#858 — the default posture is reachable and marked implied)", () => {
  test("build — the underlying default agent — is the implied posture", () => {
    expect(isImpliedAgent("build")).toBe(true)
    expect(isImpliedAgent("plan")).toBe(false)
    expect(isImpliedAgent("develop")).toBe(false)
    expect(isImpliedAgent("research")).toBe(false)
    expect(isImpliedAgent("custom")).toBe(false)
  })

  test("impliedAgent returns the marked option shape; other agents pass through unmarked", () => {
    expect(impliedAgent("build", "implizit")).toEqual({ name: "build", implied: true })
    expect(impliedAgent("plan", "implizit")).toEqual({ name: "plan", implied: false })
  })
})
