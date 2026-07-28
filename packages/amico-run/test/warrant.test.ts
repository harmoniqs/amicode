// Warrant resolution + bound checking (spec-20260727-164748 §5.1, plan task CLI-2).
// Pure: no fs, no clock — `now` is a parameter so expiry is testable.
//
// Refusal paths first. A gate that fails OPEN is worse than no gate, and the whole
// §5.1 design rests on one asymmetry: a missing plan_hash, or a bound the warrant
// omits, may only ever RESTRICT a launch — never widen it.
import { describe, it, expect } from "vitest";
import { checkWarrant, type LaunchFacts } from "../src/warrant.js";
import type { ApprovalRecord } from "../src/ledger.js";

const NOW = Date.parse("2026-07-27T20:00:00Z");
const iso = (min: number) => new Date(NOW + min * 60_000).toISOString();

const warrant = (over: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  type: "approval",
  ts: iso(-5),
  plan_hash: "9f2c",
  bounds: { max_solves: 8, tier: "free", max_size_class: "MEDIUM", device: "none" },
  expires_at: iso(30),
  issued_by: "user:cli",
  ...over,
});

/** The ungated free set: local free-tier, SMALL, no device. */
const freeLaunch = (over: Partial<LaunchFacts> = {}): LaunchFacts => ({
  tier: "free",
  executor: "local",
  sizeClass: "SMALL",
  device: "none",
  ...over,
});

describe("§5.1 rule 1 — no plan_hash", () => {
  it("a launch inside the free set is allowed", () => {
    expect(checkWarrant(freeLaunch(), [], NOW).ok).toBe(true);
  });

  it("each way out of the free set refuses INDEPENDENTLY", () => {
    const cases: [string, LaunchFacts][] = [
      ["paid tier", freeLaunch({ tier: "hpc" })],
      ["remote executor", freeLaunch({ executor: "remote" })],
      ["MEDIUM size", freeLaunch({ sizeClass: "MEDIUM" })],
      ["device write", freeLaunch({ device: "rw" })],
      ["device read", freeLaunch({ device: "ro" })],
    ];
    for (const [label, facts] of cases) {
      const r = checkWarrant(facts, [], NOW);
      expect(r.ok, label).toBe(false);
      expect(r.ok === false && r.reason).toContain("approved plan");
    }
  });

  it("an UNRESOLVED size refuses — §4.4, the gate inverts the estimator's fail-open", () => {
    // estimate.ts sizes an unresolved `levels` as SMALL (knot_point_state_dim stays
    // 1). As a gate input that is a silent widening path, so undefined is treated as
    // over-threshold, NOT as SMALL.
    const r = checkWarrant(freeLaunch({ sizeClass: undefined }), [], NOW);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/unresolved|could not/i);
  });
});

describe("§5.1 rule 2 — plan_hash present", () => {
  const launch = freeLaunch({ tier: "hpc", executor: "remote", sizeClass: "MEDIUM", plan_hash: "9f2c" });

  it("a covering warrant allows it", () => {
    expect(checkWarrant(launch, [warrant({ bounds: { tier: "hpc", max_size_class: "MEDIUM" } })], NOW).ok).toBe(true);
  });

  it("no warrant for that plan_hash refuses", () => {
    expect(checkWarrant(launch, [warrant({ plan_hash: "other" })], NOW).ok).toBe(false);
  });

  it("an EXPIRED warrant refuses", () => {
    const r = checkWarrant(launch, [warrant({ bounds: { tier: "hpc", max_size_class: "MEDIUM" }, expires_at: iso(-1) })], NOW);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/expired/i);
  });

  it("an unparseable expiry refuses — fail closed, never live", () => {
    const r = checkWarrant(launch, [warrant({ bounds: { tier: "hpc" }, expires_at: "nope" })], NOW);
    expect(r.ok).toBe(false);
  });

  // The load-bearing asymmetry.
  it("a bound the launch NEEDS but the warrant OMITS refuses — never default-allow", () => {
    // Warrant declares only the tier; the launch is also MEDIUM, which is unbounded.
    const r = checkWarrant(launch, [warrant({ bounds: { tier: "hpc" } })], NOW);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("max_size_class");
  });

  it("each exceeded bound names ITSELF and its margin", () => {
    const tooMany = checkWarrant(
      { ...launch, solvesSoFar: 8 },
      [warrant({ bounds: { tier: "hpc", max_size_class: "MEDIUM", max_solves: 8 } })],
      NOW,
    );
    expect(tooMany.ok).toBe(false);
    expect(tooMany.ok === false && tooMany.reason).toContain("max_solves");
    expect(tooMany.ok === false && tooMany.reason).toContain("8");

    const wrongTier = checkWarrant(launch, [warrant({ bounds: { tier: "free", max_size_class: "MEDIUM" } })], NOW);
    expect(wrongTier.ok === false && wrongTier.reason).toContain("tier");
  });

  it("SMALL is within a MEDIUM bound, but MEDIUM is not within SMALL", () => {
    const small = { ...launch, sizeClass: "SMALL" as const };
    expect(checkWarrant(small, [warrant({ bounds: { tier: "hpc", max_size_class: "SMALL" } })], NOW).ok).toBe(true);
    expect(checkWarrant(small, [warrant({ bounds: { tier: "hpc", max_size_class: "MEDIUM" } })], NOW).ok).toBe(true);
    expect(checkWarrant(launch, [warrant({ bounds: { tier: "hpc", max_size_class: "SMALL" } })], NOW).ok).toBe(false);
  });

  it("device: ro is within rw, and none is within anything", () => {
    const roLaunch = { ...launch, device: "ro" as const };
    expect(checkWarrant(roLaunch, [warrant({ bounds: { tier: "hpc", max_size_class: "MEDIUM", device: "rw" } })], NOW).ok).toBe(true);
    expect(checkWarrant(roLaunch, [warrant({ bounds: { tier: "hpc", max_size_class: "MEDIUM", device: "none" } })], NOW).ok).toBe(false);
  });

  it("the newest live warrant wins when several exist for one plan", () => {
    const stingy = warrant({ bounds: { tier: "hpc", max_size_class: "SMALL" }, expires_at: iso(5) });
    const generous = warrant({ bounds: { tier: "hpc", max_size_class: "MEDIUM" }, expires_at: iso(60) });
    expect(checkWarrant(launch, [stingy, generous], NOW).ok).toBe(true);
  });
});

describe("the refusal contract (§5.2)", () => {
  it("names the class, the offending bound, and what a covering warrant must declare", () => {
    const r = checkWarrant(freeLaunch({ tier: "hpc", plan_hash: "9f2c" }), [warrant({ bounds: {} })], NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("tier");
    expect(r.required).toContain("tier"); // the declaration a covering warrant needs
    expect(r.plan_hash).toBe("9f2c");
  });

  it("a refusal with no plan_hash tells you a plan is what is missing", () => {
    const r = checkWarrant(freeLaunch({ tier: "hpc" }), [], NOW);
    expect(r.ok === false && r.required).toContain("tier");
    expect(r.ok === false && r.plan_hash).toBeUndefined();
  });
});
