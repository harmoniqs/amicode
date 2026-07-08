import { describe, it, expect } from "vitest";
import { scanImports, checkImports } from "../src/import_scan.js";

const ALLOW = { allowlist: ["Piccolo", "Legato"], support_set: ["JLD2", "CairoMakie", "TOML", "Printf"] };

describe("scanImports", () => {
  it("extracts roots from every using/import form", () => {
    expect(
      scanImports(
        `using Piccolo\nusing JLD2, TOML\nimport LinearAlgebra as LA\nusing Piccolo.NamedTrajectories\nusing CairoMakie: heatmap\n# using Zygote (comment)`,
      ),
    ).toEqual({ ok: true, roots: ["Piccolo", "JLD2", "TOML", "LinearAlgebra", "CairoMakie"] });
  });
  it("fails CLOSED on a trailing-comma continuation line (multi-line using)", () => {
    const scanned = scanImports(`using Piccolo,\n  Zygote\n`);
    expect(scanned.ok).toBe(false);
    if (!scanned.ok) expect(scanned.reason).toMatch(/one statement per line/);
  });
});

describe("checkImports", () => {
  it("allows allowlist ∪ support ∪ stdlib", () => {
    expect(checkImports(["Piccolo", "JLD2", "LinearAlgebra", "Printf"], ALLOW)).toEqual({ ok: true });
  });
  it("blocks others with a one-line reason naming every blocked package", () => {
    const bad = checkImports(["Piccolo", "Zygote", "Flux"], ALLOW);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.reason).toMatch(/Zygote/);
      expect(bad.reason).toMatch(/Flux/);
      expect(bad.reason).toMatch(/not in the allowed package set/);
    }
  });
  it("issimo package blocked without entitlement", () => {
    expect(checkImports(["Piccolissimo"], ALLOW).ok).toBe(false);
  });
});
