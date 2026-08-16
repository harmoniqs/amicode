// WS2 (#370): the runtime instruction template is LOOP-FIRST and
// domain-general. Pulse-specific authoring content lives ONLY in the
// quantum-control pack's score content and arrives via the compiled section.
// Pure reorganization — the physics prose must survive verbatim.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { compileScore } from "../../src/scores/compiler";
import { loadPacks } from "../../src/scores/packs";

const TEMPLATE = fs.readFileSync(path.resolve(__dirname, "..", "..", "AGENTS.md"), "utf8");
const PACKS_ROOT = path.resolve(__dirname, "..", "..", "packs");

// The pulse-specific sections that must NO LONGER live in the static
// template (they arrive via the pack's score content).
const PACK_OWNED = [
  "## Composite authoring map (System → solve.jl)",
  "## Formulation authoring map (facets → Piccolo template)",
  "## Scope & parameter guidance",
];

function packScore() {
  const load = loadPacks([PACKS_ROOT]);
  const pack = load.packs.find((p) => p.manifest.id === "quantum-control");
  if (!pack) throw new Error(`pack missing: ${JSON.stringify(load.errors)}`);
  const primary = pack.scores.find((s) => s.manifest.id === pack.manifest.onboarding.primary)!;
  return { pack, primary };
}

describe("loop-first instruction template (WS2)", () => {
  it("the template opens with the domain-general loop, before any interview content", () => {
    const loop = TEMPLATE.indexOf("## The error-corrected research loop");
    const interview = TEMPLATE.indexOf("## Pulse-designer interview");
    expect(loop).toBeGreaterThan(-1);
    expect(loop).toBeLessThan(interview);
  });

  it("pulse authoring sections are NOT in the static template — the template is domain-general", () => {
    for (const h of PACK_OWNED) expect(TEMPLATE).not.toContain(h);
  });

  it("the pulse sections arrive through the PACK's score content (compiled output carries them)", () => {
    const compiled = compileScore(packScore().primary);
    for (const h of PACK_OWNED) expect(compiled).toContain(h);
  });

  it("pure reorganization — the physics prose survives VERBATIM (spot anchors)", () => {
    const compiled = compileScore(packScore().primary);
    // anchors lifted from the moved sections, byte-exact
    expect(compiled).toContain("`subsystem_levels` + which Piccolo system");
    expect(compiled).toContain("`MinimumTimeProblem(qcp; final_fidelity, D, Δt_bounds)`");
    expect(compiled).toContain("`N = 50` suits `T ≈ 10 ns`");
    expect(compiled).toContain("Golden reference skeletons for the canonical cases");
  });

  it("harness-level sections stay TOP-LEVEL in the template (run contract, warm-start, style)", () => {
    expect(TEMPLATE).toContain("## The run-dir contract your script MUST emit");
    expect(TEMPLATE).toContain("## Warm-start idiom");
    expect(TEMPLATE).toContain("## Style & formatting");
  });

  it("the pack loads clean through the whole surgery", () => {
    const load = loadPacks([PACKS_ROOT]);
    expect(load.errors).toEqual([]);
  });
});
