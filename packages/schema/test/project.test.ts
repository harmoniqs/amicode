import { describe, it, expect } from "vitest";
import { validate } from "../src/index.js";
import { projectToProblemSpec } from "../src/project.js";
import type { FormulationEntityLike, CompositeSystemLike } from "../src/project.js";

function sys(over: Partial<CompositeSystemLike> = {}): CompositeSystemLike {
  return {
    platform: "transmon",
    components: [{ id: "q1", role: "qubit", levels: 3, params: {} }],
    couplings: [],
    drive: { arch: "per-component" },
    ...over,
  };
}
function form(over: Partial<FormulationEntityLike> = {}): FormulationEntityLike {
  return {
    trajectory_type: "gate",
    time_mode: "fixed",
    parameterization: "smooth",
    robustness: { kind: "none", params: {} },
    free_phase: false,
    leakage: false,
    target: "X",
    objectives: [],
    constraints: [],
    ...over,
  };
}

describe("projectToProblemSpec — deterministic projection goldens (W2.1)", () => {
  it("base X gate, smooth → SmoothPulseProblem + zero_order, T/N/max_iter/integrator", () => {
    const res = projectToProblemSpec(
      form({ parameterization: "smooth", solve: { T: 40, N: 40, max_iter: 300, integrator: "tsit5" } }),
      sys(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.spec.system as any).template).toBe("TransmonSystem");
    expect((res.spec.pulse as any).kind).toBe("zero_order");
    expect((res.spec.pulse as any).T).toBe(40);
    expect((res.spec.problem as any).template).toBe("SmoothPulseProblem");
    expect((res.spec.problem as any).N).toBe(40);
    expect((res.spec.solver as any).max_iter).toBe(300);
    expect((res.spec.integrator as any).kind).toBe("bilinear");
    expect((res.spec.integrator as any).alg).toBe("tsit5");
    expect(validate(res.spec, "problemspec").ok).toBe(true);
  });

  it("cubic_spline → SplinePulseProblem + cubic_spline; linear similarly", () => {
    const cubic = projectToProblemSpec(form({ parameterization: "cubic_spline" }), sys());
    expect(cubic.ok && (cubic.spec.pulse as any).kind).toBe("cubic_spline");
    expect(cubic.ok && (cubic.spec.problem as any).template).toBe("SplinePulseProblem");
    expect(cubic.ok && validate(cubic.spec, "problemspec").ok).toBe(true);
    const linear = projectToProblemSpec(form({ parameterization: "linear_spline" }), sys());
    expect(linear.ok && (linear.spec.pulse as any).kind).toBe("linear_spline");
    expect(linear.ok && validate(linear.spec, "problemspec").ok).toBe(true);
  });

  it("bang_bang → BangBangPulseProblem + zero_order", () => {
    const r = projectToProblemSpec(form({ parameterization: "bang_bang" }), sys());
    expect(r.ok && (r.spec.pulse as any).kind).toBe("zero_order");
    expect(r.ok && (r.spec.problem as any).template).toBe("BangBangPulseProblem");
    expect(r.ok && validate(r.spec, "problemspec").ok).toBe(true);
  });

  it("min_time → goal_treatment both + free_dt + time objective + final_fidelity", () => {
    const r = projectToProblemSpec(
      form({
        time_mode: "min_time",
        time_params: { final_fidelity: 0.999, D: 50 },
        constraints: [{ kind: "dt_bounds", params: { dt_min: 0.05, dt_max: 1.5 } }],
      }),
      sys(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.spec.problem as any).goal_treatment).toBe("both");
    expect((r.spec.problem as any).free_dt).toEqual([0.05, 1.5]);
    expect((r.spec.problem as any).final_fidelity).toBeCloseTo(0.999);
    const objs = (r.spec.problem as any).objectives as Array<{ kind: string; weight: number }>;
    expect(objs.some((o) => o.kind === "time" && o.weight === 50)).toBe(true);
    expect(validate(r.spec, "problemspec").ok).toBe(true);
  });

  it("min_time without dt_bounds defaults free_dt to [0.01,2.0] and still validates", () => {
    const r = projectToProblemSpec(form({ time_mode: "min_time" }), sys());
    expect(r.ok && (r.spec.problem as any).free_dt).toEqual([0.01, 2.0]);
    expect(r.ok && validate(r.spec, "problemspec").ok).toBe(true);
  });

  it("free_phase true → problem.free_phase and forces integrator to spline|exponential", () => {
    const r = projectToProblemSpec(form({ free_phase: true, solve: { integrator: "bilinear" } }), sys());
    expect(r.ok && (r.spec.problem as any).free_phase).toBe(true);
    expect(r.ok && ["spline", "exponential"].includes((r.spec.integrator as any).kind)).toBe(true);
    expect(r.ok && validate(r.spec, "problemspec").ok).toBe(true);
  });

  it("ensemble robustness → sampling wrapper", () => {
    const r = projectToProblemSpec(form({ robustness: { kind: "ensemble", params: { sigma: 0.01 } } }), sys());
    expect(r.ok && Array.isArray(r.spec.wrappers)).toBe(true);
    expect(r.ok && (r.spec.wrappers as Array<{ kind: string }>)[0].kind).toBe("sampling");
    expect(r.ok && validate(r.spec, "problemspec").ok).toBe(true);
  });

  it("leakage true → problem.options.leakage_constraint", () => {
    const r = projectToProblemSpec(form({ leakage: true, leakage_params: { value: 0.001, cost: 10 } }), sys());
    expect(r.ok && (r.spec.problem as any).options?.leakage_constraint).toBe(true);
    expect(r.ok && (r.spec.problem as any).options?.leakage_constraint_value).toBeCloseTo(0.001);
    expect(r.ok && validate(r.spec, "problemspec").ok).toBe(true);
  });

  it("custom objective → not spec-expressible fallback with reason", () => {
    const r = projectToProblemSpec(form({ objectives: [{ kind: "custom", params: {}, label: "weird" }] }), sys());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/custom objective/);
  });

  it("custom constraint → not spec-expressible fallback", () => {
    const r = projectToProblemSpec(form({ constraints: [{ kind: "custom", params: {}, label: "odd" }] }), sys());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/custom constraint/);
  });

  it("density trajectory → not spec-expressible", () => {
    const r = projectToProblemSpec(form({ trajectory_type: "density" }), sys());
    expect(r.ok).toBe(false);
  });

  it("2-transmon CZ → MultiTransmonSystem, subsystem_levels [3,3], free_phase", () => {
    const twoQ = sys({
      platform: "transmon",
      components: [
        { id: "q1", role: "qubit", levels: 3, params: {} },
        { id: "q2", role: "qubit", levels: 3, params: {} },
      ],
      couplings: [{ between: ["q1", "q2"], kind: "cross-resonance", params: { g: 0.005 } }],
      drive: { arch: "per-component" },
    });
    const r = projectToProblemSpec(form({ target: "CZ", free_phase: true }), twoQ);
    expect(r.ok && (r.spec.system as any).template).toBe("MultiTransmonSystem");
    expect(r.ok && (r.spec.goal as any).subsystem_levels).toEqual([3, 3]);
    expect(r.ok && (r.spec.goal as any).gate).toBe("CZ");
    expect(r.ok && (r.spec.problem as any).free_phase).toBe(true);
    expect(r.ok && validate(r.spec, "problemspec").ok).toBe(true);
  });

  it("integrator MagnusGL4 → exponential/magnus_gl4, MagnusAdapt4 → spline/magnus_adapt4", () => {
    const gl4 = projectToProblemSpec(form({ solve: { integrator: "MagnusGL4" } }), sys());
    expect(gl4.ok && (gl4.spec.integrator as any).alg).toBe("magnus_gl4");
    const adapt = projectToProblemSpec(form({ solve: { integrator: "MagnusAdapt4" } }), sys());
    expect(adapt.ok && (adapt.spec.integrator as any).alg).toBe("magnus_adapt4");
  });

  it("ket trajectory → ket goal and trajectory, validates", () => {
    const r = projectToProblemSpec(form({ trajectory_type: "ket", target: "|1>" }), sys());
    expect(r.ok && (r.spec.goal as any).kind).toBe("ket");
    expect(r.ok && (r.spec.trajectory as any).kind).toBe("ket");
    expect(r.ok && validate(r.spec, "problemspec").ok).toBe(true);
  });
});

describe("kindForFilename — card.toml vs problem.toml disambiguation (W2.1)", () => {
  it("problem.toml with [system] → problemspec; card.toml → undefined", async () => {
    const { kindForFilename } = await import("../src/index.js");
    // non-existent files fall back to basename mapping
    expect(kindForFilename("/tmp/any/problem.toml")).toBe("problemspec");
    expect(kindForFilename("/tmp/any/card.toml")).toBeUndefined();
  });
  it("an on-disk card-shaped problem.toml table-sniffs to undefined", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { kindForFilename } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "kind-sniff-"));
    const cardPath = join(dir, "problem.toml");
    writeFileSync(cardPath, `[problem]\nname = "old"\nslug = "old"\ncreated = "2026-01-01T00:00:00Z"\nstatus = "designing"\nrecorded = "2026-01-01T00:00:00Z"\n`);
    expect(kindForFilename(cardPath)).toBeUndefined();
    // a real spec-shaped file still maps to problemspec
    const specDir = join(dir, "specdir");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(specDir, { recursive: true });
    const specFile = join(specDir, "problem.toml");
    writeFileSync(specFile, `schema_version = 1\nkind = "control"\n[system]\nkind = "template"\ntemplate = "TransmonSystem"\n[pulse]\nkind = "zero_order"\nT = 40\n[problem]\ntemplate = "SmoothPulseProblem"\nN = 40\n`);
    expect(kindForFilename(specFile)).toBe("problemspec");
    rmSync(dir, { recursive: true, force: true });
  });
});
