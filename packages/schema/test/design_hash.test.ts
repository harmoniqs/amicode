// designHash / planHash (spec-20260728 §2.4, §4.1).
//
// The golden vector is the point of this file. Relative change/no-change assertions
// pass against the WRONG canonicalizer — gate.ts pretty-prints and prefixes `sha256:`
// while hashing.ts is compact and bare-hex — so they would let a join against
// structureHash/problemHash break silently. Pinning one literal value pins the
// canonicalizer itself (advisory A-7).
//
// Plan: plan-20260728-104500 Task 4.
import { describe, it, expect } from "vitest";
import { designHash, planHash } from "../src/index.js";

const base = {
  task_type: "experiment-sim",
  acceptance: ["F_rolled >= 0.999"],
  budget: { max_solves: 8, tier: "free" },
};

describe("designHash", () => {
  it("is 64 lowercase hex with NO sha256: prefix", () => {
    expect(designHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("GOLDEN VECTOR — pins the canonicalizer, not merely its change behaviour", () => {
    expect(designHash(base)).toBe("6198bda6cc2a54d49bbadb1868e6b4bf1ee7fb3f02c387ec9e43978087b63257");
  });

  it("is insensitive to acceptance ORDER — independent criteria have no order", () => {
    expect(designHash({ ...base, acceptance: ["A >= 1", "B <= 2"] }))
      .toBe(designHash({ ...base, acceptance: ["B <= 2", "A >= 1"] }));
  });

  it("normalizes whitespace inside an acceptance entry", () => {
    expect(designHash({ ...base, acceptance: ["  F_rolled   >=  0.999 "] })).toBe(designHash(base));
  });

  it("ignores prose and assumptions entirely — rewording must not re-gate a warrant", () => {
    expect(designHash({ ...base, invariants: ["anything at all"], assumptions: ["x"] })).toBe(designHash(base));
  });

  it("CHANGES when a budget value changes", () => {
    expect(designHash({ ...base, budget: { max_solves: 9, tier: "free" } })).not.toBe(designHash(base));
  });

  it("CHANGES when task_type changes", () => {
    expect(designHash({ ...base, task_type: "experiment-hw" })).not.toBe(designHash(base));
  });

  // canonicalJson renders BOTH undefined and null as "null", and a literal
  // {task_type, acceptance, budget} with budget:undefined still has an enumerable
  // `budget` key — so without the compacting builder an absent budget hashes as
  // `"budget":null`: stable, permanent, and wrong, with no error anywhere.
  it("an undefined OR null budget hashes IDENTICALLY to an omitted one", () => {
    const omitted = designHash({ task_type: "implement-slice", acceptance: ["x == 1"] });
    expect(designHash({ task_type: "implement-slice", acceptance: ["x == 1"], budget: undefined })).toBe(omitted);
    expect(designHash({ task_type: "implement-slice", acceptance: ["x == 1"], budget: null })).toBe(omitted);
  });
});

describe("planHash", () => {
  it("is 64 hex over goal + steps only", () => {
    const h = planHash({ goal: "g", steps: [{ id: "s1" }] });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // compiled_at and design_hash are EXCLUDED, or a recompile that changed nothing
    // would mint a new hash and invalidate a live warrant for no reason.
    expect(planHash({ goal: "g", steps: [{ id: "s1" }], compiled_at: "now", design_hash: "d" })).toBe(h);
  });
  it("CHANGES when a step changes", () => {
    expect(planHash({ goal: "g", steps: [{ id: "s2" }] })).not.toBe(planHash({ goal: "g", steps: [{ id: "s1" }] }));
  });
});
