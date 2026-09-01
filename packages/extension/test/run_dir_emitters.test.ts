// #711 (F-709-1's landed follow-up): `wall_seconds` is a STANDING field of the
// run-dir contract — every bundled contract emitter writes it into result.toml,
// computed honestly in the script as the solve's own elapsed time
// (`t0 = time()` before the solve; `wall = time() - t0` after it). The flywheel
// (packages/amico-run/src/flywheel.ts, derivation (a)) reads result.toml
// wall_seconds FIRST — the field being standing on every emitter is what makes
// the record-carried path primary instead of the fragile FINISHED-mtime
// fallback. This pin keeps any emitter from silently dropping it.
//
// A characterization pin, stated honestly: the emission predates #711 (the
// 2/358 census in the finding was authored scripts, not bundled emitters) —
// #711's half here is the STANDING: the pin + the contract doc, so the primary
// path can never regress back to optional-in-practice.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EMITTERS = [
  "templates/skeleton_free.jl",
  "templates/solve_template.jl",
  "templates/solve_template_hp.jl",
  "templates/solve_rydberg_cz.jl",
  "scores/pasqal-mis/templates/solve.jl",
  "scores/pulse-designer/templates/solve.jl",
  "exemplars/rydberg-cz/script.jl",
];

describe("run-dir contract emitters — standing wall_seconds (#711, F-709-1)", () => {
  for (const rel of EMITTERS) {
    it(`${rel} writes wall_seconds honestly (the solve's own elapsed time)`, () => {
      const text = readFileSync(join(__dirname, "..", rel), "utf8");
      expect(text, `${rel}: the clock must start before the solve`).toMatch(/t0 = time\(\)/);
      expect(text, `${rel}: the wall clock must be the solve's own elapsed time, not a guess`).toMatch(
        /wall = time\(\) - t0/,
      );
      expect(text, `${rel}: wall_seconds must be stamped into result.toml`).toMatch(/"wall_seconds" => wall/);
    });
  }
});
