// #2180: the shipped Julia environment (packages/extension/julia) must satisfy the
// vetted pulse-designer template's own version floor. The template refuses to run
// on an older stack, so a stale pin means a beta user's first solve is refused.
//
// The minimums are read from the template's version-probe error text (the single
// source of truth the template enforces), not restated here, so a future bump of
// the template's floor fails this test until the shipped manifest follows.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";

const EXT = path.resolve(__dirname, "..");
const TEMPLATE = path.join(EXT, "scores", "pulse-designer", "templates", "solve.jl");
const PROJECT = path.join(EXT, "julia", "Project.toml");
const MANIFEST = path.join(EXT, "julia", "Manifest.toml");

type Version = [number, number, number];

function parseVersion(v: string): Version {
  const [a = 0, b = 0, c = 0] = v.split(".").map((x) => Number.parseInt(x, 10));
  return [a, b, c];
}

function atLeast(have: string, floor: string): boolean {
  const h = parseVersion(have);
  const f = parseVersion(floor);
  for (let i = 0; i < 3; i++) {
    if (h[i] !== f[i]) return h[i] > f[i];
  }
  return true;
}

/** The template's version-probe floors, e.g. { Piccolo: "2.2", DirectTrajOpt: "0.11", ... }. */
function templateFloors(): Record<string, string> {
  const src = fs.readFileSync(TEMPLATE, "utf8");
  const floors: Record<string, string> = {};
  for (const m of src.matchAll(/requires Piccolo ≥ ([\d.]+)/g)) floors.Piccolo = m[1];
  for (const m of src.matchAll(/DirectTrajOpt ≥ ([\d.]+)/g)) floors.DirectTrajOpt ??= m[1];
  for (const m of src.matchAll(/NamedTrajectories ≥ ([\d.]+)/g)) floors.NamedTrajectories ??= m[1];
  return floors;
}

function manifestVersion(name: string): string | undefined {
  const manifest = parseToml(fs.readFileSync(MANIFEST, "utf8")) as {
    deps?: Record<string, Array<{ version?: string }>>;
  };
  return manifest.deps?.[name]?.[0]?.version;
}

/** Non-stdlib packages the template loads with `using`/`import` at top level. */
function templatePackageImports(): string[] {
  const src = fs.readFileSync(TEMPLATE, "utf8");
  const names = new Set<string>();
  for (const m of src.matchAll(/^(?:using|import)\s+([A-Za-z][\w]*)/gm)) names.add(m[1]);
  return [...names];
}

const STDLIBS = new Set(["LinearAlgebra", "Printf", "SparseArrays", "Dates", "Random", "SHA", "Statistics"]);

describe("shipped Julia environment vs the vetted template's version floor (#2180)", () => {
  const floors = templateFloors();

  it("the template declares floors for Piccolo, DirectTrajOpt and NamedTrajectories", () => {
    expect(Object.keys(floors).sort()).toEqual(["DirectTrajOpt", "NamedTrajectories", "Piccolo"]);
  });

  for (const pkg of ["Piccolo", "DirectTrajOpt", "NamedTrajectories"]) {
    it(`the shipped Manifest resolves ${pkg} at or above the template's floor`, () => {
      const have = manifestVersion(pkg);
      expect(have, `${pkg} missing from the shipped Manifest`).toBeDefined();
      expect(atLeast(have!, floors[pkg]), `${pkg} ${have} < template floor ${floors[pkg]}`).toBe(true);
    });
  }

  it("every non-stdlib package the template imports is a direct dep of the shipped Project", () => {
    const project = parseToml(fs.readFileSync(PROJECT, "utf8")) as { deps?: Record<string, string> };
    const deps = new Set(Object.keys(project.deps ?? {}));
    const missing = templatePackageImports().filter((n) => !STDLIBS.has(n) && !deps.has(n));
    expect(missing).toEqual([]);
  });

  it("the Project's compat floors cannot resolve below the template's floor", () => {
    const project = parseToml(fs.readFileSync(PROJECT, "utf8")) as { compat?: Record<string, string> };
    for (const pkg of ["Piccolo", "DirectTrajOpt", "NamedTrajectories"]) {
      const spec = project.compat?.[pkg];
      expect(spec, `${pkg} has no [compat] bound`).toBeDefined();
      // Julia caret semantics: the lowest version a spec admits is its leading number.
      const lowest = spec!.split(",")[0].trim().replace(/^[\^~=]/, "");
      expect(atLeast(lowest, floors[pkg]), `${pkg} compat "${spec}" admits below ${floors[pkg]}`).toBe(true);
    }
  });
});
