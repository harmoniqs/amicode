// ledger-record schema (Plan 3 / L1 Task 2) — a draft-07 `oneOf` discriminated on
// `type` over the six ledger record kinds. Registered in the SCHEMAS registry ONLY
// (never SUPPORTED_VERSIONS_BY_KIND — it has no top-level properties.schema_version,
// so adding it there crashes @amicode/schema at module load; same as problemspec).
import { describe, it, expect } from "vitest";
import { validate, SCHEMA_KINDS, SUPPORTED_VERSIONS_BY_KIND, type SchemaKind } from "../src/index.js";

const hasErr = (errs: string[], needle: string) => errs.some((e) => e.includes(needle));

const solve = () => ({
  type: "solve",
  ts: "2026-07-22T00:00:00Z",
  session: "s1",
  problem: "cz",
  structure_hash: "abc",
  problem_hash: "def",
  kind: "control",
  tier: "spec",
  summary: {
    platform: "transmon",
    template: "SplinePulseProblem",
    trajectory: "unitary",
    N: 100,
    T: 100.0,
    goal: "CZ",
    solver: "ipopt",
    strategy: "direct",
  },
  warm_start: null,
  source: "user",
  outcome: { converged: true, fidelity: 0.9994, iterations: 214, wall_s: 38.2 },
  versions: { Piccolo: "0.9.2" },
});

describe("ledger-record schema — registration", () => {
  it("is registered in SCHEMAS (SCHEMA_KINDS) so consumers can validate it", () => {
    expect(SCHEMA_KINDS).toContain("ledger-record" as SchemaKind);
  });
  it("is EXCLUDED from SUPPORTED_VERSIONS_BY_KIND (oneOf has no top-level schema_version)", () => {
    expect(Object.keys(SUPPORTED_VERSIONS_BY_KIND)).not.toContain("ledger-record");
  });
});

describe("ledger-record schema — solve", () => {
  it("a full valid solve record passes", () => {
    expect(validate(solve(), "ledger-record").errors).toEqual([]);
  });
  it("a solve missing structure_hash fails", () => {
    const bad = solve() as Record<string, unknown>;
    delete bad.structure_hash;
    const r = validate(bad, "ledger-record");
    expect(r.ok).toBe(false);
  });
  it("a solve with an unknown source value fails (enum: user|replay|simulated)", () => {
    expect(validate({ ...solve(), source: "guessed" }, "ledger-record").ok).toBe(false);
  });
  it("source: simulated is accepted (the Prova isolation bridge)", () => {
    expect(validate({ ...solve(), source: "simulated" }, "ledger-record").ok).toBe(true);
  });
  it("source: replay is accepted", () => {
    expect(validate({ ...solve(), source: "replay" }, "ledger-record").ok).toBe(true);
  });
});

describe("ledger-record schema — the other five kinds", () => {
  it("verdict validates; a bad verdict enum fails", () => {
    expect(
      validate(
        { type: "verdict", ts: "t", problem_hash: "def", structure_hash: "abc", verdict: "agree", fidelity_rerolled: 0.9993, fidelity_reported: 0.9994 },
        "ledger-record",
      ).errors,
    ).toEqual([]);
    expect(validate({ type: "verdict", ts: "t", problem_hash: "def", verdict: "maybe" }, "ledger-record").ok).toBe(false);
  });
  it("attempt_error validates (empty errors array allowed)", () => {
    expect(validate({ type: "attempt_error", ts: "t", session: "s0", errors: [] }, "ledger-record").errors).toEqual([]);
    expect(
      validate({ type: "attempt_error", ts: "t", errors: [{ path: "problem.Q", msg: "must be number" }] }, "ledger-record").errors,
    ).toEqual([]);
  });
  it("fallback validates; missing reason fails", () => {
    expect(validate({ type: "fallback", ts: "t", from_tier: "spec", reason: "custom objective kind" }, "ledger-record").errors).toEqual([]);
    expect(validate({ type: "fallback", ts: "t", from_tier: "spec" }, "ledger-record").ok).toBe(false);
  });
  it("override validates; auto_accepted is required (correction #7)", () => {
    expect(
      validate({ type: "override", ts: "t", param: "Q", recommended: 100.0, applied: 250.0, structure_hash: "abc", auto_accepted: false }, "ledger-record").errors,
    ).toEqual([]);
    const noAuto = { type: "override", ts: "t", param: "Q", recommended: 100.0, applied: 250.0, structure_hash: "abc" };
    expect(validate(noAuto, "ledger-record").ok).toBe(false);
  });
  it("burn validates", () => {
    expect(
      validate({ type: "burn", ts: "t", class: "shared-artifact", mechanism: "aliased referee state", receipt: "PR #92", fixture: "test/slow/x.jl", prevention: "inner constructor" }, "ledger-record").errors,
    ).toEqual([]);
  });
});

describe("ledger-record schema — discriminator", () => {
  it("an unknown type fails (no oneOf branch matches)", () => {
    expect(validate({ type: "nonesuch", ts: "t" }, "ledger-record").ok).toBe(false);
  });
});
