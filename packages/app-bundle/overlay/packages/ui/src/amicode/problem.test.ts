// #1818: the deprecated research surfaces are gone; the problem module is
// reduced to its live exports (chipText, compositeChip, formulationProjection)
// and this file tests exactly those. The parsers and view helpers that served
// the removed readouts retired with them; the refetch predicates moved to
// refetch-edge.test.ts.
import { describe, expect, test } from "bun:test"
import { chipText, compositeChip, formulationProjection } from "./problem"

describe("chipText per-kind compact renderers (the live receipt vocabulary)", () => {
  test("system: structured fields", () => {
    expect(chipText("system", { platform: "transmon", levels: 4, params: { drive_max: 0.2 } })).toBe(
      "transmon · 4 lvl · cap 0.2",
    )
    expect(chipText("system", { platform: "rydberg" })).toBe("rydberg")
  })
  test("formulation: structured mode facets (NOT the phantom problem_type)", () => {
    expect(
      chipText("formulation", {
        trajectory_type: "gate",
        time_mode: "min_time",
        robustness: { kind: "ensemble" },
        free_phase: true,
      }),
    ).toBe("gate · min-time · ensemble · free-phase")
    // legacy free-form maps through the projection:
    expect(chipText("formulation", { problem: "state_prep", target: "|1>" })).toBe("ket")
    // an entity carrying ONLY the phantom problem_type is ignored → default gate:
    expect(chipText("formulation", { problem_type: "gate_synthesis" })).toBe("gate")
  })
  test("unknown kind: generic key=value join, nested flattened bare, notes skipped", () => {
    expect(chipText("pulse", { format: "jld2", knots: 51, notes: "long text" })).toBe("format=jld2 · knots=51")
  })
})

describe("compositeChip: the composite system chip (the live derivation)", () => {
  test("a composite entity renders its component count; a flat one falls back", () => {
    const composite = {
      platform: "transmon",
      components: [
        { id: "q1", role: "qubit", levels: 3 },
        { id: "q2", role: "qubit", levels: 3 },
      ],
      couplings: [{ between: ["q1", "q2"], kind: "cross-resonance" }],
    }
    expect(compositeChip(composite)).toContain("2")
    expect(() => compositeChip({} as any)).not.toThrow()
  })
})

describe("formulationProjection: the mode-facet projection (live receipt rendering)", () => {
  test("free-form fields map onto the structured facets", () => {
    const projection = formulationProjection({ problem: "state_prep", target: "|1>" })
    expect(projection).toBeTruthy()
  })
  test("structured fields pass through", () => {
    const projection = formulationProjection({ trajectory_type: "gate", time_mode: "min_time" })
    expect(projection).toBeTruthy()
  })
})
