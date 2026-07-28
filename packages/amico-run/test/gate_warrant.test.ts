// The gate's warrant step (spec-20260727-164748 §5.1, plan CLI-2) as wired into
// runGate. warrant.test.ts covers the decision matrix; this covers the WIRING:
// that the step is genuinely absent without a context, that it runs after the
// consistency checks, and that it refuses before any hash is minted.
import { describe, it, expect } from "vitest";
import { runGate, type WarrantContext } from "../src/gate.js";
import type { ApprovalRecord } from "../src/ledger.js";
import { DEFAULT_ALLOWLIST, DEFAULT_SUPPORT, type AuthoringConfig } from "../src/authoring.js";

const NOW = Date.parse("2026-07-27T20:00:00Z");

/** A schema-valid spec that passes steps 1-4: free tier needs a sandbox env. */
const spec = (over: Record<string, unknown> = {}) => ({
  schema_version: "5",
  lab_id: "default",
  script_path: "/tmp/solve.jl",
  tier: "free",
  env: { kind: "sandbox" },
  ...over,
});

const SCRIPT = "using Piccolo\n";
const AUTHORING: AuthoringConfig = {
  allowlist: DEFAULT_ALLOWLIST,
  support_set: DEFAULT_SUPPORT,
  verify_tolerance: 1e-4,
};

const ctx = (over: Partial<WarrantContext> = {}): WarrantContext => ({
  approvals: [],
  now: NOW,
  sizeClass: "SMALL",
  device: "none",
  ...over,
});

const warrant = (bounds: ApprovalRecord["bounds"], plan_hash = "9f2c"): ApprovalRecord => ({
  type: "approval",
  ts: new Date(NOW - 60_000).toISOString(),
  plan_hash,
  bounds,
  expires_at: new Date(NOW + 1_800_000).toISOString(),
  issued_by: "user:cli",
});

describe("the flag is the absence of the context", () => {
  it("with NO warrant context, a launch that would be refused still passes", () => {
    // hpc + MEDIUM + device rw is squarely outside the free set, and there is no
    // warrant anywhere — but the step does not exist, so nothing changes. This is
    // what makes CLI-2 safe to land before anyone opts in.
    const r = runGate(spec({ tier: "hpc", executor: "local" }), SCRIPT, AUTHORING);
    // fails for its own pre-existing reason (hpc cannot run locally), NOT for a warrant
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/cannot run locally/);
    expect(r.ok === false && r.refusal).toBeUndefined();
  });

  it("a free-set launch passes with the context armed", () => {
    const r = runGate(spec(), SCRIPT, AUTHORING, ctx());
    expect(r.ok).toBe(true);
  });
});

describe("ordering", () => {
  it("a schema failure reads as a schema failure, not as unwarranted", () => {
    const r = runGate({ lab_id: "x" }, SCRIPT, AUTHORING, ctx({ sizeClass: "MEDIUM" }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("solvespec schema");
    expect(r.ok === false && r.refusal).toBeUndefined();
  });

  it("a tier/env inconsistency reads as that, not as unwarranted", () => {
    const r = runGate(spec({ env: { kind: "project" } }), SCRIPT, AUTHORING, ctx({ sizeClass: "MEDIUM" }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("sandbox");
    expect(r.ok === false && r.refusal).toBeUndefined();
  });
});

describe("the warrant step itself", () => {
  it("refuses a MEDIUM launch with no plan_hash, and mints NO stamp", () => {
    const r = runGate(spec(), SCRIPT, AUTHORING, ctx({ sizeClass: "MEDIUM" }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.refusal?.required).toContain("max_size_class");
    expect("stamp" in r).toBe(false); // no hash for a launch that will not run
  });

  it("allows it once a covering warrant is approved for its plan_hash", () => {
    const r = runGate(spec({ plan_hash: "9f2c" }), SCRIPT, AUTHORING, {
      ...ctx({ sizeClass: "MEDIUM" }),
      approvals: [warrant({ max_size_class: "MEDIUM" })],
    });
    expect(r.ok).toBe(true);
  });

  it("carries the §5.2 structured refusal alongside the one-line reason", () => {
    const r = runGate(spec({ plan_hash: "9f2c" }), SCRIPT, AUTHORING, {
      ...ctx({ sizeClass: "MEDIUM" }),
      approvals: [warrant({})],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal?.plan_hash).toBe("9f2c");
    expect(r.refusal?.required).toContain("max_size_class");
    expect(r.reason).toContain("max_size_class");
  });

  it("an unresolved size refuses even inside an otherwise-free launch (§4.4)", () => {
    const r = runGate(spec(), SCRIPT, AUTHORING, ctx({ sizeClass: undefined }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/unresolved/i);
  });
});
