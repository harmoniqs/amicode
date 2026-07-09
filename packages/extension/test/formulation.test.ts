import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import { normalizeFormulation, updateFormulation, validateFormulation, formulationWarnings, formulationToml } from "../opencode-plugin/entities";

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

describe("validateFormulation", () => {
  const good = normalizeFormulation({ problem: "gate_synthesis", target: "CZ", objective: "unitary infidelity", constraints: [] });
  it("passes a good entity", () => {
    expect(validateFormulation(good)).toEqual([]);
  });
  it("flags an unknown enum value", () => {
    const bad = { ...good, trajectory_type: "bogus" as any };
    expect(validateFormulation(bad).length).toBeGreaterThan(0);
  });
  it("flags an unknown objective kind", () => {
    const bad = { ...good, objectives: [{ kind: "nope" as any, params: {} }] };
    expect(validateFormulation(bad).some((p) => p.includes("objectives[0]"))).toBe(true);
  });
});

describe("formulationWarnings", () => {
  it("min_time without final_fidelity and without dt_bounds → two warnings", () => {
    const e = normalizeFormulation({ trajectory_type: "gate", time_mode: "min_time" });
    const w = formulationWarnings(e);
    expect(w.some((x) => /final_fidelity/.test(x))).toBe(true);
    expect(w.some((x) => /dt_bounds/.test(x))).toBe(true);
  });
  it("free_phase warning fires only when componentCount === 1", () => {
    const e = normalizeFormulation({ trajectory_type: "gate", free_phase: true });
    expect(formulationWarnings(e, 1).some((x) => /free_phase/.test(x))).toBe(true);
    expect(formulationWarnings(e, 2).some((x) => /free_phase/.test(x))).toBe(false);
    expect(formulationWarnings(e).some((x) => /free_phase/.test(x))).toBe(false); // undefined N → skipped
  });
});

describe("formulationToml round-trip (§8)", () => {
  it("round-trips modes, inline param bags, and array-of-table sets", () => {
    const e = normalizeFormulation({
      trajectory_type: "gate",
      time_mode: "min_time",
      time_params: { final_fidelity: 0.999, D: 100 },
      parameterization: "cubic_spline",
      robustness: { kind: "ensemble", params: { n_systems: 3 } },
      free_phase: true,
      leakage: true,
      leakage_params: { value: 0.001, cost: 0.01 },
      target: "CZ",
      objectives: [{ kind: "reg_du", params: { R: 0.00001 }, label: "smooth" }],
      constraints: [{ kind: "bounds", params: {} }, { kind: "dt_bounds", params: {} }],
      solve: { T: 0.5, N: 51, max_iter: 500, integrator: "MagnusGL4" },
    });
    const doc = parse(formulationToml(e)) as any;
    expect(doc.formulation.trajectory_type).toBe("gate");
    expect(doc.formulation.time_mode).toBe("min_time");
    expect(doc.formulation.time_params).toEqual({ final_fidelity: 0.999, D: 100 });
    expect(doc.formulation.robustness).toEqual({ kind: "ensemble", params: { n_systems: 3 } });
    expect(doc.formulation.free_phase).toBe(true);
    expect(doc.formulation.leakage_params).toEqual({ value: 0.001, cost: 0.01 });
    expect(doc.formulation.objectives).toEqual([{ kind: "reg_du", params: { R: 0.00001 }, label: "smooth" }]);
    expect(doc.formulation.constraints.map((c: any) => c.kind)).toEqual(["bounds", "dt_bounds"]);
    expect(doc.formulation.solve.integrator).toBe("MagnusGL4");
  });
});
