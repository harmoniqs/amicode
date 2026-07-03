import { describe, it, expect } from "vitest";
import { parseIndexLine, RunRegistry } from "../src/run_registry";

// Pure multi-run registry (1.2, #57) — the vscode-free state the RunsManager
// keys on. The index grammar matches amico-run's appendIndex writer
// (`runId\tcreatedAt\tscriptPath\n`, path sanitized of tabs/newlines).

describe("parseIndexLine — runs/index grammar", () => {
  it("parses the writer's TSV line", () => {
    expect(parseIndexLine("r20260703-010203Z-ab12\t2026-07-03T01:02:03Z\t/tmp/solve.jl")).toEqual({
      runId: "r20260703-010203Z-ab12", createdAt: "2026-07-03T01:02:03Z", scriptPath: "/tmp/solve.jl",
    });
  });
  it("rejects blank and malformed lines (torn final line heals on next drain)", () => {
    expect(parseIndexLine("")).toBeUndefined();
    expect(parseIndexLine("   ")).toBeUndefined();
    expect(parseIndexLine("r1\tonly-two-fields")).toBeUndefined();
    expect(parseIndexLine("\t\t/s.jl")).toBeUndefined();      // empty runId
  });
  it("re-joins extra tabs into the path (defensive — the writer sanitizes)", () => {
    expect(parseIndexLine("r1\t2026-01-01T00:00:00Z\t/a\tb.jl")?.scriptPath).toBe("/a\tb.jl");
  });
});

describe("RunRegistry", () => {
  it("registration is idempotent by runId (index replays from 0 every launch)", () => {
    const reg = new RunRegistry();
    expect(reg.register({ runId: "r1", runDir: "/runs/r1", phase: "live" })).toBe(true);
    expect(reg.register({ runId: "r1", runDir: "/elsewhere", phase: "finished" })).toBe(false);
    expect(reg.get("r1")?.runDir).toBe("/runs/r1");            // first registration wins
    expect(reg.get("r1")?.phase).toBe("live");
  });
  it("noteIter is a monotonic high-water mark", () => {
    const reg = new RunRegistry();
    reg.register({ runId: "r1", runDir: "/runs/r1", phase: "live" });
    reg.noteIter("r1", 5);
    reg.noteIter("r1", 3);                                     // out-of-order (poll double-delivery)
    expect(reg.get("r1")?.latestIter).toBe(5);
    reg.noteIter("nope", 9);                                   // unknown run — no throw
  });
  it("markFinished sets phase/status/fidelity and keeps latestIter", () => {
    const reg = new RunRegistry();
    reg.register({ runId: "r1", runDir: "/runs/r1", phase: "live" });
    reg.noteIter("r1", 42);
    reg.markFinished("r1", "completed", 0.9991);
    expect(reg.get("r1")).toMatchObject({ phase: "finished", status: "completed", fidelity: 0.9991, latestIter: 42 });
  });
});
