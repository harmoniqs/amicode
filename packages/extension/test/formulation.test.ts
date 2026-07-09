import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeFormulation, updateFormulation } from "../opencode-plugin/entities";

const corpus = JSON.parse(
  readFileSync(new URL("./fixtures/formulation-migration.json", import.meta.url), "utf8"),
) as { pairs: { name: string; legacy: unknown; structured: unknown }[] };

describe("normalizeFormulation (shared migration corpus §10)", () => {
  for (const pair of corpus.pairs) {
    it(`migrates: ${pair.name}`, () => {
      expect(normalizeFormulation(pair.legacy)).toEqual(pair.structured);
    });
    it(`idempotent: ${pair.name}`, () => {
      const once = normalizeFormulation(pair.legacy);
      expect(normalizeFormulation(once)).toEqual(once);
    });
  }
});

describe("updateFormulation", () => {
  it("normalizes a legacy existing, then upserts patch facets", () => {
    const existing = { problem: "gate_synthesis", target: "CZ", objective: "unitary infidelity", constraints: [] };
    const merged = updateFormulation(existing, { time_mode: "min_time", time_params: { final_fidelity: 0.999 } });
    expect(merged.trajectory_type).toBe("gate"); // preserved from normalize
    expect(merged.time_mode).toBe("min_time"); // patched
    expect(merged.time_params).toEqual({ final_fidelity: 0.999 });
    expect(merged.target).toBe("CZ"); // untouched
  });
  it("replaces whole sets and shallow-merges param bags", () => {
    const base = {
      trajectory_type: "gate",
      objectives: [{ kind: "reg_u", params: { R: 1e-4 } }],
      leakage_params: { value: 1e-3 },
    };
    const merged = updateFormulation(base, {
      objectives: [{ kind: "reg_du", params: { R: 1e-5 } }],
      leakage: true,
      leakage_params: { cost: 1e-2 },
    });
    expect(merged.objectives).toEqual([{ kind: "reg_du", params: { R: 1e-5 } }]);
    expect(merged.leakage).toBe(true);
    expect(merged.leakage_params).toEqual({ value: 1e-3, cost: 1e-2 }); // shallow-merged
  });
});
