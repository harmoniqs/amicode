import { describe, it, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { formulationProjection } from "./problem"

const corpus = JSON.parse(
  readFileSync(new URL("./fixtures/formulation-migration.json", import.meta.url), "utf8"),
) as { pairs: { name: string; legacy: any; structured: any }[] }

// Compare ONLY the mapped facet fields (not the derived primaryKey / synthesized
// final_fidelity, which aren't in `structured`) — the anti-drift lock against
// the amicode-side normalizeFormulation (§9/§10).
const mapped = (p: any) => ({
  trajectory_type: p.trajectory_type,
  time_mode: p.time_mode,
  parameterization: p.parameterization,
  robustness: p.robustness,
  free_phase: p.free_phase,
  leakage: p.leakage,
  target: p.target,
  objectives: p.objectives,
  constraints: p.constraints,
})

describe("formulationProjection (shared corpus — anti-drift lock)", () => {
  for (const pair of corpus.pairs) {
    it(`maps facets: ${pair.name}`, () => {
      expect(mapped(formulationProjection(pair.legacy))).toEqual(pair.structured)
    })
  }
})

describe("formulationProjection primaryKey + robustness", () => {
  const P = (o: any) => formulationProjection(o).primaryKey
  it("derives per trajectory_type + free_phase + time_mode", () => {
    expect(P({ trajectory_type: "gate" })).toBe("unitary_infidelity")
    expect(P({ trajectory_type: "gate", free_phase: true })).toBe("unitary_free_phase")
    expect(P({ trajectory_type: "ket" })).toBe("ket_infidelity")
    expect(P({ trajectory_type: "multiket" })).toBe("ket_infidelity")
    expect(P({ trajectory_type: "density" })).toBe("density_infidelity")
    expect(P({ trajectory_type: "gate", time_mode: "min_time" })).toBe("min_time")
  })
  it("min_time surfaces derivedFinalFidelity from time_params", () => {
    const p = formulationProjection({ trajectory_type: "gate", time_mode: "min_time", time_params: { final_fidelity: 0.999 } })
    expect(p.derivedFinalFidelity).toBe(0.999)
  })
  it("never throws on an unknown enum; passes the raw string through", () => {
    const p = formulationProjection({ trajectory_type: "bogus" })
    expect(p.trajectory_type).toBe("bogus")
  })
})
