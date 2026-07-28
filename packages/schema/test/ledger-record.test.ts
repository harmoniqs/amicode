// ledger-record schema (Plan 3 / L1 Task 2; `dispatch` added by the fleet substrate,
// §6.3 Rev 5) — a draft-07 `oneOf` discriminated on `type` over the SEVEN ledger
// record kinds. Registered in the SCHEMAS registry ONLY
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

// ── the 7th kind: tier dispatch (fleet §6.3 Rev 5) ─────────────────────────────
// Tier dispatch rides THIS ledger rather than building a second store, so the row is
// a stanza here and validate-on-append covers it for free.
const dispatch = () => ({
  type: "dispatch",
  ts: "2026-07-24T12:00:00Z",
  task_type: "author-script",
  work_id: "structhash-abc",
  model: "anthropic/claude-haiku-4-5",
  variant: "high",
  gate: "re-rollout",
  pass: true,
  tokens: 1840,
  attempt_index: 1,
  source: "user",
});

describe("ledger-record schema — dispatch", () => {
  it("a full valid dispatch row passes", () => {
    expect(validate(dispatch(), "ledger-record").errors).toEqual([]);
  });

  it("every field is required", () => {
    for (const k of ["ts", "task_type", "work_id", "model", "variant", "gate", "pass", "tokens", "attempt_index", "source"]) {
      const bad = dispatch() as Record<string, unknown>;
      delete bad[k];
      expect(validate(bad, "ledger-record").ok, `missing ${k} should fail`).toBe(false);
    }
  });

  // The sim/hw axis is carried in the taxonomy, so a LANE-LESS task_type is not a
  // cosmetic defect: it is how simulated pass-rates would reach hardware routing.
  it("task_type is a closed enum — a lane-less `experiment` is rejected", () => {
    expect(validate({ ...dispatch(), task_type: "experiment" }, "ledger-record").ok).toBe(false);
    expect(validate({ ...dispatch(), task_type: "experiment-sim" }, "ledger-record").errors).toEqual([]);
    expect(validate({ ...dispatch(), task_type: "experiment-hw" }, "ledger-record").errors).toEqual([]);
    expect(validate({ ...dispatch(), task_type: "converse" }, "ledger-record").errors).toEqual([]);
  });

  it("model must carry a provider prefix and variant must be non-empty (co-stamping)", () => {
    expect(validate({ ...dispatch(), model: "claude-haiku-4-5" }, "ledger-record").ok).toBe(false);
    expect(validate({ ...dispatch(), variant: "" }, "ledger-record").ok).toBe(false);
  });

  it("attempt_index is an integer >= 1 and tokens an integer >= 0 (experiment rows: 1 and 0)", () => {
    expect(validate({ ...dispatch(), attempt_index: 0 }, "ledger-record").ok).toBe(false);
    expect(validate({ ...dispatch(), attempt_index: 1.5 }, "ledger-record").ok).toBe(false);
    expect(validate({ ...dispatch(), tokens: -1 }, "ledger-record").ok).toBe(false);
    expect(validate({ ...dispatch(), tokens: 0, attempt_index: 1 }, "ledger-record").errors).toEqual([]);
  });

  it("source accepts the simulated bridge (tier dispatch counts it, opt-in, sim-lane only)", () => {
    expect(validate({ ...dispatch(), source: "simulated", task_type: "experiment-sim", tokens: 0 }, "ledger-record").errors).toEqual([]);
    expect(validate({ ...dispatch(), source: "guessed" }, "ledger-record").ok).toBe(false);
  });

  it("pass is a boolean, and unknown keys are rejected", () => {
    expect(validate({ ...dispatch(), pass: "yes" }, "ledger-record").ok).toBe(false);
    expect(validate({ ...dispatch(), tier: "spec" }, "ledger-record").ok).toBe(false);
  });
});

// approval — the capability warrant (spec-20260727-164748 §5). The EIGHTH kind.
// Deliberately unsigned: the threat model is drift, not an adversary (spec §3), and
// the agent holds unrestricted bash, so a signature would defend against an attacker
// this layer could not stop anyway.
const approval = () => ({
  type: "approval",
  ts: "2026-07-27T20:00:00Z",
  plan_hash: "9f2c",
  bounds: { max_solves: 8, tier: "free", max_size_class: "MEDIUM", device: "none" },
  expires_at: "2026-07-27T21:00:00Z",
  issued_by: "user:ui",
});

describe("ledger-record schema — approval (capability warrant)", () => {
  it("a fully-declared warrant validates", () => {
    expect(validate(approval(), "ledger-record").errors).toEqual([]);
  });

  it("empty bounds validate — a warrant authorising nothing beyond the free set is legal", () => {
    // §5.1 rule 2: a bound the launch needs but the warrant omits REFUSES rather
    // than defaulting allow, so an empty bounds object is safe, not a hole.
    expect(validate({ ...approval(), bounds: {} }, "ledger-record").errors).toEqual([]);
  });

  it("each required field is genuinely required", () => {
    for (const key of ["type", "ts", "plan_hash", "bounds", "expires_at", "issued_by"]) {
      const partial: Record<string, unknown> = { ...approval() };
      delete partial[key];
      expect(validate(partial, "ledger-record").ok, `missing ${key} must fail`).toBe(false);
    }
  });

  it("unknown keys are rejected, like every sibling kind", () => {
    expect(validate({ ...approval(), signature: "deadbeef" }, "ledger-record").ok).toBe(false);
    expect(validate({ ...approval(), bounds: { max_solves: 8, nonesuch: 1 } }, "ledger-record").ok).toBe(false);
  });

  it("device bounds use the §2.1 permission vocabulary", () => {
    for (const device of ["none", "ro", "rw"]) {
      expect(validate({ ...approval(), bounds: { device } }, "ledger-record").ok, device).toBe(true);
    }
    expect(validate({ ...approval(), bounds: { device: "yes" } }, "ledger-record").ok).toBe(false);
  });

  it("max_size_class is the cost proxy that exists — G-8 removed max_duration_s", () => {
    for (const c of ["SMALL", "MEDIUM"]) {
      expect(validate({ ...approval(), bounds: { max_size_class: c } }, "ledger-record").ok, c).toBe(true);
    }
    expect(validate({ ...approval(), bounds: { max_size_class: "LARGE" } }, "ledger-record").ok).toBe(false);
    // the removed bound must not quietly validate again
    expect(validate({ ...approval(), bounds: { max_duration_s: 1800 } }, "ledger-record").ok).toBe(false);
  });

  it("max_solves must be a positive integer", () => {
    expect(validate({ ...approval(), bounds: { max_solves: 0 } }, "ledger-record").ok).toBe(false);
    expect(validate({ ...approval(), bounds: { max_solves: 1.5 } }, "ledger-record").ok).toBe(false);
  });

  it("plan_hash must be non-empty — an empty hash would join every launch", () => {
    expect(validate({ ...approval(), plan_hash: "" }, "ledger-record").ok).toBe(false);
  });
});

describe("ledger-record schema — discriminator", () => {
  it("an unknown type fails (no oneOf branch matches)", () => {
    expect(validate({ type: "nonesuch", ts: "t" }, "ledger-record").ok).toBe(false);
  });
});
