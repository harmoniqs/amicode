import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { structureHash, problemHash, canonicalJson, fullDict, structureFields } from "../src/hashing.js";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "fixtures", "hashes");
const tomls = readdirSync(dir).filter((f) => f.endsWith(".toml")).sort();

// The sidecars are emitted by Piccolo (src/specs/schema/emit_hash_fixtures.jl) via
// Piccolo.Specs.structure_hash / problem_hash. The TS mirror in src/hashing.ts must
// reproduce them byte-for-byte from the SAME TOML (plan review correction #3 + #4).
describe("cross-language hashes (TS == Julia sidecar)", () => {
  it("has a non-trivial fixture corpus", () => {
    expect(tomls.length).toBeGreaterThanOrEqual(4);
  });

  for (const f of tomls) {
    it(`matches Julia hashes for ${f}`, () => {
      const spec = parseToml(readFileSync(join(dir, f), "utf8"));
      const expected = JSON.parse(readFileSync(join(dir, f.replace(".toml", ".hashes.json")), "utf8"));
      expect(structureHash(spec)).toBe(expected.structure_hash);
      expect(problemHash(spec)).toBe(expected.problem_hash);
    });
  }
});

// The int/float-agnostic landmine (correction #3, concrete): schema_version=1,
// N=100, subsystem_levels=[3,3] (integers) with T=100.0 (float). smol-toml parses
// 100.0 -> JS number 100 and TOML.jl parses it -> Float64; the numeric rule must
// render BOTH as the bare integer "100". If this diverges, the two canonical-JSON
// strings are printed side-by-side by the assertion failure.
describe("landmine: int/float-agnostic canonical JSON", () => {
  const spec = parseToml(readFileSync(join(dir, "landmine.toml"), "utf8"));

  it("problem-instance canonical JSON is byte-identical to Julia's full_dict", () => {
    // Captured verbatim from `julia src/specs/schema/emit_hash_fixtures.jl`.
    const julia =
      '{"goal":{"gate":"CZ","kind":"unitary","subsystem_levels":[3,3]},"kind":"control",' +
      '"problem":{"N":100,"Q":100,"R":0.01,"free_dt":false,"free_phase":false,' +
      '"goal_treatment":"objective","template":"SplinePulseProblem"},' +
      '"pulse":{"T":100,"init":"default","kind":"cubic_spline","seed":0},"schema_version":1,' +
      '"solver":{"backend":"ipopt","device":"cpu","max_iter":500,"precision":"f64","strategy":"direct"},' +
      '"system":{"kind":"template","template":"TransmonSystem"}}';
    expect(canonicalJson(fullDict(spec))).toBe(julia);
    expect(canonicalJson(fullDict(spec))).toContain('"T":100'); // float 100.0 -> bare "100"
  });

  it("structure canonical JSON is byte-identical to Julia's structure_fields", () => {
    const julia =
      '{"kind":"control","problem":{"free_dt":"fixed","free_phase":false,' +
      '"goal_treatment":"objective","objective_kinds":[],"template":"SplinePulseProblem"},' +
      '"pulse_kind":"cubic_spline",' +
      '"solver":{"backend":"ipopt","device":"cpu","precision":"f64","strategy":"direct"},' +
      '"system":{"kind":"template","template":"TransmonSystem"},"trajectory_kind":"unitary",' +
      '"wrapper_kinds":[]}';
    expect(canonicalJson(structureFields(spec))).toBe(julia);
  });
});

// Unit checks for the pinned numeric rule (mirror the Julia @testitem in hashes.jl).
describe("canonicalJson numeric rule (mirror of Julia)", () => {
  it("integer-valued numbers render as bare integers", () => {
    expect(canonicalJson(100)).toBe("100");
    expect(canonicalJson(100.0)).toBe("100"); // JS cannot tell this from 100
    expect(canonicalJson(0)).toBe("0");
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson(-5)).toBe("-5");
    expect(canonicalJson(2.0)).toBe("2");
  });
  it("non-integers use ECMAScript Number::toString", () => {
    expect(canonicalJson(0.02)).toBe("0.02");
    expect(canonicalJson(0.0001)).toBe("0.0001");
    expect(canonicalJson(1e-5)).toBe("0.00001");
    expect(canonicalJson(1e-6)).toBe("0.000001");
    expect(canonicalJson(1e-7)).toBe("1e-7");
    expect(canonicalJson(0.999)).toBe("0.999");
    expect(canonicalJson(123.45)).toBe("123.45");
  });
  it("containers: sorted keys, no spaces, bool/null literals", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson([1, 2.0, true, null])).toBe("[1,2,true,null]");
  });
});
