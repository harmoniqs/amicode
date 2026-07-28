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
  const step = (over: Record<string, unknown> = {}) => ({
    id: "s1", model: "anthropic/claude-opus-5", task_type: "implement-slice", gates: ["re-rollout"], ...over,
  });
  const plan = (over: Record<string, unknown> = {}) => ({
    schema_version: "1", plan_id: "plan-20260728-1045-x", goal: "g",
    plan_hash: "c".repeat(64), design_hash: "a".repeat(64),
    steps: [step()], max_replans: 3,
    ...over,
  });
  it("accepts a compiled plan", () => {
    expect(validate(plan(), "plan")).toMatchObject({ ok: true });
  });
  it("requires the design_hash it was compiled from", () => {
    expect(validate(drop(plan(), "design_hash"), "plan").ok).toBe(false);
  });
  it("accepts an optional-step marker — HALF the `skipped` producer", () => {
    // The other half is a `bypassed` verdict row. `optional: true` alone is a permission,
    // not an event, which is why `skipped` was unreachable for three revisions.
    expect(validate(plan({ steps: [step({ optional: true })] }), "plan").ok).toBe(true);
  });

  // §4.2's compile-time budget refusal reads these. A planner that omitted them yielded an
  // EMPTY demand set, so every refusal passed silently — §0.1's inert counter, fourth instance.
  it("REQUIRES model on every step — an undeterminable tier demand is not `unbounded`", () => {
    expect(validate(plan({ steps: [drop(step(), "model")] }), "plan").ok).toBe(false);
  });
  it("REQUIRES task_type — it is what decides whether a step is solve-bearing", () => {
    expect(validate(plan({ steps: [drop(step(), "task_type")] }), "plan").ok).toBe(false);
  });
  it("model must be a model id (provider/name), never a trust tier", () => {
    // `bounds.tier` speaks free|composed|vetted|hpc; a step's `model` is a model id. The two
    // are different vocabularies, which is why `tier` is a first-launch refusal.
    expect(validate(plan({ steps: [step({ model: "hpc" })] }), "plan").ok).toBe(false);
    expect(validate(plan({ steps: [step({ model: "anthropic/claude-haiku-4-5" })] }), "plan").ok).toBe(true);
  });
  it("declares permissions.device over the DEVICE_ORDER vocabulary", () => {
    expect(validate(plan({ steps: [step({ permissions: { device: "rw" } })] }), "plan").ok).toBe(true);
    expect(validate(plan({ steps: [step({ permissions: { device: "admin" } })] }), "plan").ok).toBe(false);
  });
});

describe("registration", () => {
  it("both kinds carry a version, so the module does not crash at load", () => {
    expect(SUPPORTED_VERSIONS_BY_KIND.spec).toEqual(["1"]);
    expect(SUPPORTED_VERSIONS_BY_KIND.plan).toEqual(["1"]);
  });
});
