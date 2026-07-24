import { describe, it, expect } from "vitest";
import { validate, kindForFilename, SCHEMA_KINDS } from "../src/index.js";

// A valid `control` ProblemSpec matching the FULL vendored variant that is
// registered as the `problemspec` kind. `schema_version` is the INTEGER `1`
// (plan review correction #6 — problemspec keeps an integer enum `[1]` and is
// registered in SCHEMAS only, NOT in SUPPORTED_VERSIONS_BY_KIND).
const validControlSpec = {
  schema_version: 1,
  kind: "control",
  system: { kind: "template", template: "TransmonSystem" },
  goal: { kind: "unitary", gate: "CZ", subsystem_levels: [3, 3] },
  pulse: { kind: "cubic_spline", T: 100.0 },
  problem: { template: "SplinePulseProblem", N: 100 },
  solver: { backend: "ipopt" },
};

describe("problemspec schema", () => {
  it("is a registered schema kind", () => {
    expect(SCHEMA_KINDS).toContain("problemspec");
  });

  it("accepts a valid control spec", () => {
    const r = validate(validControlSpec, "problemspec");
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("rejects an unknown system template (fails both oneOf branches)", () => {
    const bad = { ...validControlSpec, system: { kind: "template", template: "Nope" } };
    expect(validate(bad, "problemspec").ok).toBe(false);
  });

  it("rejects an unknown top-level key (per-branch additionalProperties:false)", () => {
    const bad = { ...validControlSpec, bogus: 1 };
    expect(validate(bad, "problemspec").ok).toBe(false);
  });

  it("routes problem.toml to the problemspec kind", () => {
    expect(kindForFilename("/some/dir/problem.toml")).toBe("problemspec");
  });
});
