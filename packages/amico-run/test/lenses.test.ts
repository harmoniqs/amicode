// The six tier-1 lenses (spec-20260728 §3.1).
//
// Every lens returns {status, findings}: `not-applicable` and a clean `ran` must be
// distinguishable, because collapsing them is how a blocking lens that could not run
// reads as a pass (§3.2, §3.4).
//
// Plan: plan-20260728-104500 Task 9.
import { describe, it, expect } from "vitest";
import { baseline, budget, falsifiable, precedent, provenance, schema } from "../src/lenses.js";

const launch = {
  schema_version: "1",
  spec_id: "spec-1",
  task_type: "experiment-sim",
  acceptance: ["F_rolled >= 0.999"],
  budget: { max_solves: 8, tier: "free" },
  baseline: { value: 0.968, source: "published blockade-pi protocol" },
};
const slice = { schema_version: "1", spec_id: "spec-2", task_type: "implement-slice", acceptance: ["x == 1"] };
const drop = (o: Record<string, unknown>, k: string) => { const c = { ...o }; delete c[k]; return c; };

describe("schema", () => {
  it("clean on a valid launch-shaped spec", () => {
    expect(schema(launch)).toEqual({ status: "ran", findings: [] });
  });
  it("BLOCKS and names the offending fields", () => {
    const r = schema(drop(launch, "spec_id"));
    expect(r.findings[0].severity).toBe("blocking");
    expect(r.findings[0].evidence).toMatch(/spec_id/);
  });
  it("every finding carries a remedy — an unactionable finding is dropped", () => {
    for (const f of schema(drop(launch, "spec_id")).findings) expect(f.remedy).not.toBe("");
  });
});

describe("falsifiable", () => {
  it("REJECTS prose — the lens the spec itself failed at Rev 2", () => {
    const r = falsifiable({ acceptance: ["The system should be fast and correct."] });
    expect(r.status).toBe("ran");
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].severity).toBe("blocking");
  });
  it("accepts metric · comparator · threshold", () => {
    expect(falsifiable({ acceptance: ["F_rolled >= 0.999", "wall_s <= 600"] }).findings).toEqual([]);
  });
  it("accepts ==, scientific notation and a percentage", () => {
    expect(falsifiable({ acceptance: ["leakage <= 1e-4", "coverage == 100%", "n_steps == 3"] }).findings).toEqual([]);
  });
  it("accepts a dotted metric name", () => {
    expect(falsifiable({ acceptance: ["outcome.fidelity >= 0.99"] }).findings).toEqual([]);
  });
  it("BLOCKS an empty or absent acceptance list", () => {
    expect(falsifiable({ acceptance: [] }).findings[0].severity).toBe("blocking");
    expect(falsifiable({}).findings[0].severity).toBe("blocking");
  });
  it("reports how many entries failed and quotes them", () => {
    const r = falsifiable({ acceptance: ["F >= 0.9", "it should be good", "also fast"] });
    expect(r.findings[0].claim).toMatch(/2 acceptance entries/);
    expect(r.findings[0].evidence).toMatch(/should be good/);
  });
});

describe("budget", () => {
  it("clean on a legal budget", () => {
    expect(budget(launch).findings).toEqual([]);
  });
  it("rejects max_duration via validateBounds, not a prose restatement", () => {
    const r = budget({ ...launch, budget: { max_duration: "30m" } });
    expect(r.findings[0].severity).toBe("blocking");
    expect(r.findings[0].remedy).toMatch(/max_duration/);
  });
  it("BLOCKS launch-shaped work with no budget at all", () => {
    expect(budget(drop(launch, "budget")).findings[0].severity).toBe("blocking");
  });
  it("is NOT-APPLICABLE for a non-launch-shaped spec (not a vacuous pass)", () => {
    expect(budget(slice).status).toBe("not-applicable");
  });
  it("is not-applicable when task_type is missing entirely", () => {
    expect(budget({ acceptance: ["x == 1"] }).status).toBe("not-applicable");
  });
});

describe("baseline", () => {
  it("accepts a value WITH a source", () => {
    expect(baseline(launch).findings).toEqual([]);
  });
  it("accepts an explicit none_because", () => {
    expect(baseline({ ...launch, baseline: { none_because: "first of its kind" } }).findings).toEqual([]);
  });
  it("BLOCKS when absent — 'we never checked' must not pass silently", () => {
    expect(baseline(drop(launch, "baseline")).findings[0].severity).toBe("blocking");
  });
  it("BLOCKS a bare value with no source", () => {
    expect(baseline({ ...launch, baseline: { value: 0.9 } }).findings[0].severity).toBe("blocking");
  });
  it("is not-applicable for non-launch-shaped work", () => {
    expect(baseline(slice).status).toBe("not-applicable");
  });
});

describe("precedent", () => {
  it("reports NOT-APPLICABLE — not a zero count — with no work identity", () => {
    expect(precedent(launch).status).toBe("not-applicable");
  });
  it("reports prior attempts when a structure_hash resolves", () => {
    const r = precedent({ ...launch, structure_hash: "sh1" }, { queryLedger: () => ({ total: 3, verified: 1 }) });
    expect(r.status).toBe("ran");
    expect(r.findings[0].severity).toBe("advisory");
    expect(r.findings[0].claim).toMatch(/3 prior attempts/);
    expect(r.findings[0].claim).toMatch(/1 verified/);
  });
  it("is clean when the identity resolves but nothing was ever attempted", () => {
    const r = precedent({ ...launch, structure_hash: "sh1" }, { queryLedger: () => ({ total: 0, verified: 0 }) });
    expect(r).toEqual({ status: "ran", findings: [] });
  });
  it("advises warm-starting differently when NOTHING prior verified", () => {
    const r = precedent({ ...launch, structure_hash: "sh1" }, { queryLedger: () => ({ total: 4, verified: 0 }) });
    expect(r.findings[0].remedy).toMatch(/no prior attempt verified/i);
  });
  it("is UNVERIFIED when the ledger cannot be queried — never a silent clean", () => {
    const r = precedent({ ...launch, structure_hash: "sh1" }, { queryLedger: () => undefined });
    expect(r.status).toBe("unverified");
  });
  it("never reads the ledger itself — with no injected query it is unverified, not a throw", () => {
    expect(precedent({ ...launch, structure_hash: "sh1" }).status).toBe("unverified");
  });
});

describe("provenance", () => {
  it("advises when a baseline value carries no source", () => {
    const r = provenance({ ...launch, baseline: { value: 0.9 } });
    expect(r.findings[0].severity).toBe("advisory");
  });
  it("clean when the number names its source", () => {
    expect(provenance(launch).findings).toEqual([]);
  });
  it("clean when there is no numeric baseline to source", () => {
    expect(provenance({ ...launch, baseline: { none_because: "novel" } }).findings).toEqual([]);
    expect(provenance(slice).findings).toEqual([]);
  });
});

describe("cross-lens invariants", () => {
  it("no tier-1 lens ever throws on garbage input", () => {
    for (const lens of [schema, falsifiable, budget, baseline, precedent, provenance]) {
      for (const bad of [{}, { task_type: 3 }, { acceptance: "not a list" }, { budget: 7 }, { baseline: "no" }]) {
        expect(() => lens(bad as Record<string, unknown>)).not.toThrow();
      }
    }
  });
  it("every finding from every lens carries a non-empty remedy", () => {
    const specs = [{}, drop(launch, "baseline"), { ...launch, budget: { max_duration: "x" } }, { acceptance: ["prose here"] }];
    for (const lens of [schema, falsifiable, budget, baseline, provenance]) {
      for (const s of specs) for (const f of lens(s as Record<string, unknown>).findings) expect(f.remedy.length).toBeGreaterThan(0);
    }
  });
  it("carries the round through to every finding", () => {
    expect(falsifiable({ acceptance: ["prose"] }, { round: 3 }).findings[0].round).toBe(3);
  });
});
