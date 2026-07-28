// The `spec` and `plan` schema kinds (spec-20260728 §2, §4.1).
// Plan: plan-20260728-104500 Task 5.
import { describe, it, expect } from "vitest";
import { validate, SUPPORTED_VERSIONS_BY_KIND } from "../src/index.js";

const spec = (over: Record<string, unknown> = {}) => ({
  schema_version: "1",
  spec_id: "spec-20260728-093846-x",
  type: "spec",
  task_type: "experiment-sim",
  acceptance: ["F_rolled >= 0.999"],
  budget: { max_solves: 8, tier: "free" },
  baseline: { value: 0.968, source: "published blockade-pi protocol" },
  // real vault-taxonomy keys that MUST be tolerated — they share the frontmatter block
  date: "2026-07-28", session_id: "u", status: "draft", tags: ["spec"], linked_plan: null,
  ...over,
});
const drop = (o: Record<string, unknown>, k: string) => { const c = { ...o }; delete c[k]; return c; };

describe("the spec kind", () => {
  it("accepts a launch-shaped spec alongside the vault's own frontmatter keys", () => {
    expect(validate(spec(), "spec")).toMatchObject({ ok: true });
  });
  it("REQUIRES budget for launch-shaped task types", () => {
    expect(validate(drop(spec(), "budget"), "spec").ok).toBe(false);
  });
  it("FORBIDS budget for non-launch-shaped task types", () => {
    expect(validate(spec({ task_type: "implement-slice" }), "spec").ok).toBe(false);
  });
  it("accepts a non-launch-shaped spec with no budget", () => {
    expect(validate(drop(spec({ task_type: "implement-slice" }), "budget"), "spec").ok).toBe(true);
  });
  it("rejects a task_type outside TASK_TYPES", () => {
    expect(validate(spec({ task_type: "vibes" }), "spec").ok).toBe(false);
  });
  it("rejects a budget key outside WarrantBounds (the $ref must actually resolve)", () => {
    expect(validate(spec({ budget: { max_duration: "30m" } }), "spec").ok).toBe(false);
  });
  it("does NOT require `review` — it is written BY the review", () => {
    expect(validate(spec(), "spec").ok).toBe(true);
  });
  it("baseline: accepts value+source, accepts none_because, rejects a bare value", () => {
    expect(validate(spec({ baseline: { none_because: "first of its kind" } }), "spec").ok).toBe(true);
    expect(validate(spec({ baseline: { value: 0.9 } }), "spec").ok).toBe(false);
  });
});

describe("the plan kind", () => {
  const plan = (over: Record<string, unknown> = {}) => ({
    schema_version: "1", plan_id: "plan-20260728-1045-x", goal: "g",
    plan_hash: "c".repeat(64), design_hash: "a".repeat(64),
    steps: [{ id: "s1", gates: ["re-rollout"] }], max_replans: 3,
    ...over,
  });
  it("accepts a compiled plan", () => {
    expect(validate(plan(), "plan")).toMatchObject({ ok: true });
  });
  it("requires the design_hash it was compiled from", () => {
    expect(validate(drop(plan(), "design_hash"), "plan").ok).toBe(false);
  });
  it("accepts an optional-step marker, the only producer of `skipped`", () => {
    expect(validate(plan({ steps: [{ id: "s1", optional: true }] }), "plan").ok).toBe(true);
  });
});

describe("registration", () => {
  it("both kinds carry a version, so the module does not crash at load", () => {
    expect(SUPPORTED_VERSIONS_BY_KIND.spec).toEqual(["1"]);
    expect(SUPPORTED_VERSIONS_BY_KIND.plan).toEqual(["1"]);
  });
});
