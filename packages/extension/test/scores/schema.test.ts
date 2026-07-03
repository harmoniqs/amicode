import { describe, it, expect } from "vitest";
import { validateScoreManifest, KNOWN_ENTITIES } from "../../src/scores/schema";

const VALID = {
  type: "score", schema_version: 1, id: "pasqal-mis", version: 1, derived_from: null,
  name: "Solve a graph problem", outcome: "An optimized waveform", audience: ["algorithms"],
  duration_estimate: "60–90 min",
  device: { backend: "pasqal", qpu_runnable: true, emulators: ["emu-mps"] },
  entitlements: ["pasqal-hackathon-2026"],
  stages: [
    { id: "application", emits: ["circuit"], questions: [{ id: "graph", prompt: "Which graph?", choices: ["sample", "upload"], default: "sample" }] },
    { id: "solve", emits: ["run", "pulse"], executor: "cloud-altissimo", template: "templates/solve.jl" },
    { id: "device-sim", emits: ["device_session"], backend: "emu-mps", gate: "light" },
    { id: "device-qpu", emits: ["device_session"], backend: "fresnel", gate: "heavy" },
  ],
};

describe("validateScoreManifest", () => {
  it("accepts a valid manifest", () => expect(validateScoreManifest(VALID)).toEqual([]));
  it("rejects an unknown entity in emits", () => {
    const m = structuredClone(VALID); (m.stages[0] as any).emits = ["blob"];
    expect(validateScoreManifest(m).join()).toMatch(/unknown entity.*blob/i);
  });
  it("rejects an unknown gate class", () => {
    const m = structuredClone(VALID); (m.stages[2] as any).gate = "medium";
    expect(validateScoreManifest(m).join()).toMatch(/unknown gate/i);
  });
  it("rejects non-positive version", () => {
    const m = structuredClone(VALID); m.version = 0;
    expect(validateScoreManifest(m).join()).toMatch(/version/);
  });
  it("rejects unsupported schema_version", () => {
    const m = structuredClone(VALID); m.schema_version = 99;
    expect(validateScoreManifest(m).join()).toMatch(/schema_version/);
  });
  it("rejects duplicate stage ids", () => {
    const m = structuredClone(VALID); m.stages.push({ id: "solve" } as any);
    expect(validateScoreManifest(m).join()).toMatch(/duplicate stage/i);
  });
  it("rejects a question missing id or prompt", () => {
    const m = structuredClone(VALID); (m.stages[0] as any).questions = [{ prompt: "no id" }];
    expect(validateScoreManifest(m).join()).toMatch(/question.*id/i);
  });
  it("rejects a default not among choices", () => {
    const m = structuredClone(VALID);
    (m.stages[0] as any).questions = [{ id: "q", prompt: "p", choices: ["a", "b"], default: "c" }];
    expect(validateScoreManifest(m).join()).toMatch(/default not among choices/i);
  });
  it("IGNORES unknown fields (additive schema policy, spec §8)", () => {
    const m = structuredClone(VALID); (m as any).future_field = { x: 1 };
    (m.stages[0] as any).future_stage_field = true;
    expect(validateScoreManifest(m)).toEqual([]);
  });
  it("rejects empty stages", () => {
    const m = structuredClone(VALID); m.stages = [];
    expect(validateScoreManifest(m).join()).toMatch(/stages/);
  });
  it("exports the workflow-frames entity vocabulary", () =>
    expect(KNOWN_ENTITIES).toEqual(["circuit", "system", "formulation", "pulse", "run", "device_session", "knowledge"]));
});
