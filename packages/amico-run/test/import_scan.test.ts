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
  it("sees @eval using/import inside a function and refuses it with the top-level reason", () => {
    const topLevel = scanImports(`using Zygote\n`);
    expect(topLevel.ok).toBe(true);
    if (!topLevel.ok) return;
    const topReason = checkImports(topLevel.roots, ALLOW);
    expect(topReason.ok).toBe(false);
    for (const form of ["@eval using Zygote", "@eval import Zygote", "@eval using Zygote: gradient", "@eval(using Zygote)"]) {
      const scanned = scanImports(`using DelimitedFiles\nfunction main()\n    ${form}\n    Base.invokelatest(run)\nend\n`);
      expect(scanned.ok, form).toBe(true);
      if (!scanned.ok) continue;
      expect(scanned.roots, form).toEqual(["DelimitedFiles", "Zygote"]);
      expect(checkImports(scanned.roots, ALLOW), form).toEqual(topReason);
    }
  });
  it("scans using/import inside function bodies and begin … end blocks", () => {
    const scripts = [
      `function main()\n    using Zygote\nend\n`,
      `begin\n    import Zygote\nend\n`,
      `@eval begin\n    using Zygote\nend\n`,
      `begin using Zygote end\n`,
      `function main(); using Zygote; end\n`,
      `x = 1; import Zygote\n`,
    ];
    for (const script of scripts) expect(scanImports(script), script).toEqual({ ok: true, roots: ["Zygote"] });
  });
  it("fails CLOSED on dynamic import forms it cannot parse", () => {
    const forms = [
      `Base.require(Main, :Zygote)`,
      `Base.require(Base.PkgId(Base.UUID("e88e6eb3-aa80-5325-afca-941959d7151f"), "Zygote"))`,
      `eval(:(using Zygote))`,
      `Core.eval(Main, Expr(:using, Expr(:., :Zygote)))`,
      `@eval Main using Zygote`,
    ];
    for (const form of forms) {
      const scanned = scanImports(`function main()\n    ${form}\nend\n`);
      expect(scanned.ok, form).toBe(false);
      if (!scanned.ok) expect(scanned.reason, form).toMatch(/not supported/);
    }
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
  it("allows the DelimitedFiles stdlib (and the other shipped stdlibs) without a workaround", () => {
    const scanned = scanImports(`using DelimitedFiles\n`);
    expect(scanned.ok).toBe(true);
    if (scanned.ok) expect(checkImports(scanned.roots, ALLOW)).toEqual({ ok: true });
    expect(
      checkImports(["DelimitedFiles", "Mmap", "Sockets", "Downloads", "FileWatching", "Libdl", "Profile"], ALLOW),
    ).toEqual({ ok: true });
  });
  it("issimo package blocked without entitlement", () => {
    expect(checkImports(["Piccolissimo"], ALLOW).ok).toBe(false);
  });
});
