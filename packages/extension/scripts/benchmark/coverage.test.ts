import { describe, it, expect } from "vitest";
import { computeCoverage, ALL_TOOLS } from "./coverage";

// A minimal fake transcript: meta + two turns with tool calls.
const fixture = [
  { kind: "meta", model: "m1", scenario: "H1", run: 1 },
  { kind: "turn", index: 1, toolCalls: [{ tool: "amicode_pick_system", input: {} }], stage: "nominal", iterationIndex: 0 },
  { kind: "turn", index: 2, toolCalls: [{ tool: "amicode_formulate", input: {} }], stage: "nominal", iterationIndex: 1 },
];

describe("computeCoverage", () => {
  it("counts distinct amicode tools hit per model", () => {
    const cov = computeCoverage({ m1: [fixture] });
    expect(cov.m1.toolsHit.sort()).toEqual(["amicode_formulate", "amicode_pick_system"]);
    expect(cov.m1.hitCount).toBe(2);
    expect(cov.m1.total).toBe(ALL_TOOLS.length); // 12
  });

  it("reports max iteration depth per stage", () => {
    const cov = computeCoverage({ m1: [fixture] });
    expect(cov.m1.maxIteration.nominal).toBe(1);
  });

  it("ignores non-amicode tools (bash/read/etc.) in the /12 count", () => {
    const withBash = [{ kind: "turn", index: 1, toolCalls: [{ tool: "bash", input: {} }] }];
    const cov = computeCoverage({ m1: [withBash] });
    expect(cov.m1.hitCount).toBe(0);
  });
});
