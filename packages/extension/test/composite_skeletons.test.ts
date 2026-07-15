// Golden-skeleton SNAPSHOT check (spec-20260709 §5 / §7.7, plan F3).
//
// This is a STRUCTURAL PRESENCE check of the documented example solve.jl skeletons —
// it verifies the intended authoring output (right constructor + per-component
// subsystem_levels + free_phase = N for entanglers), NOT a composite→constructor
// mapping function (deliberately NOT built — that's the §9 load-bearing non-goal).
// Real mapping verification is the Task 10 live run.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (name: string) =>
  readFileSync(new URL(`./fixtures/composite-skeletons/${name}`, import.meta.url), "utf8");

describe("composite → solve.jl golden skeletons (snapshot presence)", () => {
  it("2-transmon CZ → MultiTransmonSystem, subsystem_levels [3, 3], free_phase", () => {
    const s = read("cz-2transmon.jl");
    expect(s).toContain("MultiTransmonSystem");
    expect(s).toContain("subsystem_levels = [3, 3]");
    expect(s).toContain("EmbeddedOperator");
    expect(s).toContain("free_phase = true");
  });

  it("Rydberg CZ (global) → GlobalRydbergSystem, 3-level per atom, free_phase", () => {
    const s = read("cz-rydberg-global.jl");
    expect(s).toContain("GlobalRydbergSystem");
    expect(s).toContain("subsystem_levels = [3, 3]");
    expect(s).toContain("free_phase = true");
  });

  it("heterogeneous cavity+qubit → cavity system with a Fock-truncated cavity level", () => {
    const s = read("cavity-qubit.jl");
    expect(s).toContain("subsystem_levels = [2, 12]"); // qubit 2, cavity Fock cutoff 12
    expect(s).toContain("dispersive-chi");
    expect(s).toContain("free_phase = true");
  });
});
