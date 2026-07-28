// The lens registry (spec-20260728 §3.1, §3.5).
//
// Covers advisory A-9: Rev 1 of the spec covered 5 of 10 task types, so half the closed
// enum fell through to a single lens while --critics defaulted to 3. Exhaustiveness is a
// test here, not a convention.
//
// Plan: plan-20260728-104500 Task 8.
import { describe, it, expect } from "vitest";
import { TASK_TYPES } from "../src/ledger.js";
import {
  LENS_REGISTRY,
  LENS_REGISTRY_VERSION,
  criticCountFor,
  isLaunchShaped,
  isTaskType,
  tier1LensesFor,
  tier2LensesFor,
} from "../src/lens_registry.js";

describe("exhaustiveness", () => {
  it("has an entry for EVERY value of TASK_TYPES", () => {
    for (const t of TASK_TYPES) expect(LENS_REGISTRY[t], `missing registry entry: ${t}`).toBeDefined();
  });
  it("has no entry for a task type that does not exist", () => {
    expect(Object.keys(LENS_REGISTRY).sort()).toEqual([...TASK_TYPES].sort());
  });
  it("stamps a version, so a review is attributable to the rules that produced it", () => {
    expect(LENS_REGISTRY_VERSION).toMatch(/^\S+$/);
  });
});

describe("tier 1", () => {
  it("always includes schema and falsifiable — the contract and the criteria", () => {
    for (const t of TASK_TYPES) {
      expect(tier1LensesFor(t)).toContain("schema");
      expect(tier1LensesFor(t)).toContain("falsifiable");
    }
  });
  it("scopes budget/baseline/precedent to launch-shaped work only", () => {
    for (const t of TASK_TYPES) {
      const has = tier1LensesFor(t).includes("budget");
      expect(has).toBe(isLaunchShaped(t));
      expect(tier1LensesFor(t).includes("baseline")).toBe(isLaunchShaped(t));
      expect(tier1LensesFor(t).includes("precedent")).toBe(isLaunchShaped(t));
    }
  });
  it("names exactly the three launch-shaped types", () => {
    expect(TASK_TYPES.filter(isLaunchShaped)).toEqual(["author-script", "experiment-sim", "experiment-hw"]);
  });
});

describe("tier 2", () => {
  it("gives conversational/bookkeeping types NO critics — spending a frontier call there is the bureaucracy trap", () => {
    for (const t of ["triage", "bookkeeping", "converse"] as const) expect(tier2LensesFor(t)).toEqual([]);
  });
  it("puts hidden-failure AND decomposition in every non-empty set", () => {
    for (const t of TASK_TYPES) {
      const l = tier2LensesFor(t);
      if (l.length > 0) {
        expect(l, `hidden-failure missing for ${t}`).toContain("hidden-failure");
        // Rev 1 withheld decomposition from implement-slice, so the specs most exposed to
        // bad carving were the one category never reviewed for it.
        expect(l, `decomposition missing for ${t}`).toContain("decomposition");
      }
    }
  });
  it("gives implement-slice the decomposition lens (the Rev-1 defect)", () => {
    expect(tier2LensesFor("implement-slice")).toContain("decomposition");
  });
  it("has no duplicate lenses in any set", () => {
    for (const t of TASK_TYPES) {
      const l = tier2LensesFor(t);
      expect(new Set(l).size, `duplicates for ${t}`).toBe(l.length);
    }
  });
});

describe("criticCountFor — the clamp", () => {
  it("clamps a request to the lenses that actually exist", () => {
    expect(criticCountFor("review", 3)).toBe(tier2LensesFor("review").length);
    expect(criticCountFor("implement-slice", 99)).toBe(tier2LensesFor("implement-slice").length);
  });
  it("clamps to ZERO for a tier-1-only type, however many are requested", () => {
    expect(criticCountFor("bookkeeping", 3)).toBe(0);
  });
  it("honours a request smaller than the lens count", () => {
    expect(criticCountFor("implement-slice", 1)).toBe(1);
  });
  it("never returns a negative count", () => {
    expect(criticCountFor("plan", -5)).toBe(0);
  });
});

describe("isTaskType", () => {
  it("accepts every real value and rejects anything else", () => {
    for (const t of TASK_TYPES) expect(isTaskType(t)).toBe(true);
    for (const bad of ["vibes", "", null, undefined, 3, {}]) expect(isTaskType(bad)).toBe(false);
  });
});
