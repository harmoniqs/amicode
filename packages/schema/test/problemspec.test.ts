import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validate, validateFile, kindForFilename, SCHEMA_KINDS } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const validDir = join(here, "fixtures", "valid");
const invalidDir = join(here, "fixtures", "invalid");
const problemspecFixtures = (dir: string) =>
  readdirSync(dir).filter((f) => f.startsWith("problemspec-") && f.endsWith(".toml"));

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

// ── fixture sweep: every valid/problemspec-* passes ajv; every invalid/* fails ──
// The corpus covers both oneOf branches (control + rollout) and every conditional:
// SplinePulseProblem->cubic/linear pulse, free_dt oneOf (false | [lo,hi] | bare-true
// reject), free_phase->{exponential,spline} integrator, nested objective enums, and
// per-branch additionalProperties:false. These same fixtures feed the Julia
// (JSONSchema.jl) lane in julia/runtests.jl — the two validators must agree on
// accept/reject for every file (plan review correction #5).
describe("problemspec fixture sweep (ajv)", () => {
  const valid = problemspecFixtures(validDir);
  const invalid = problemspecFixtures(invalidDir);

  it("has a non-trivial corpus of both valid and invalid problemspec fixtures", () => {
    expect(valid.length).toBeGreaterThanOrEqual(4);
    expect(invalid.length).toBeGreaterThanOrEqual(4);
  });

  for (const f of valid) {
    it(`valid/${f} conforms`, () => {
      const r = validateFile(join(validDir, f), "problemspec");
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    });
  }

  for (const f of invalid) {
    it(`invalid/${f} is rejected`, () => {
      const r = validateFile(join(invalidDir, f), "problemspec");
      expect(r.ok).toBe(false);
      expect(r.errors.length).toBeGreaterThan(0);
    });
  }
});
