// Derived step state and the completion rule (spec-20260728 §4.4, §4.5).
// Plan: plan-20260728-160000 Task 4.
//
// REACHABILITY IS TESTED BEFORE UNFORGEABILITY, on purpose. Rev 2 of the spec had two covering
// tests and both were negative — they would have passed vacuously against an implementation where
// `passed` is unreachable for every step. So the positive cases come first here.
//
// The positive tests drive `appendRecord` DIRECTLY, which is the shipped write path. They are not
// "the real emission path": nothing emits step verdicts until the fleet harness walk, which is
// §10 step 8 and Jack-gated (G-1b). Until then every step of a live plan reads `pending`, which
// is the honest answer rather than a hidden one.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRecord, readRecords, type LedgerRecord } from "../src/ledger.js";
import { derivePlanState, deriveAdvisories, deriveStepStates, type PlanShape } from "../src/plan_state.js";

const PH = "plan-hash-1";
const OTHER = "plan-hash-2";
const ts = (n = 1) => `2026-07-28T10:0${n}:00.000Z`;

const verdict = (over: Record<string, unknown>): LedgerRecord =>
  ({ type: "verdict", ts: ts(), plan_hash: PH, source: "user", ...over }) as LedgerRecord;
const dispatch = (over: Record<string, unknown>): LedgerRecord =>
  ({
    type: "dispatch", ts: ts(), task_type: "implement-slice", work_id: "w1",
    model: "anthropic/claude-opus-5", variant: "high", gate: "re-rollout", pass: true,
    tokens: 10, attempt_index: 1, source: "user", plan_hash: PH, ...over,
  }) as LedgerRecord;
const todo = (over: Record<string, unknown>): LedgerRecord =>
  ({ type: "todo", ts: ts(), plan_hash: PH, source: "user", ...over }) as LedgerRecord;

const plan = (over: Partial<PlanShape> = {}): PlanShape => ({
  plan_hash: PH, steps: [{ id: "s1" }], advisories: [], max_replans: 3, ...over,
});

describe("reachability — asserted BEFORE the negative tests", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plan-state-"));
    process.env.AMICO_LEDGER = join(dir, "runs.jsonl");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.AMICO_LEDGER;
  });

  it("a verdict row appended through the SHIPPED write path reads `passed`", () => {
    appendRecord(verdict({ step_id: "s1", verdict: "agree" }) as never);
    const view = derivePlanState(readRecords(), plan());
    expect(view.steps[0]).toMatchObject({ id: "s1", state: "passed" });
    expect(view.state).toBe("complete");
  });

  it("ALL FIVE states are reachable", () => {
    const rows: LedgerRecord[] = [
      verdict({ step_id: "pass", verdict: "agree" }),
      verdict({ step_id: "fail", verdict: "exhausted" }),
      verdict({ step_id: "skip", verdict: "bypassed" }),
      dispatch({ step_id: "run" }),
      // "wait" gets no rows at all
    ];
    for (const r of rows) appendRecord(r as never);
    const view = derivePlanState(readRecords(), plan({
      steps: [{ id: "pass" }, { id: "fail" }, { id: "skip", optional: true }, { id: "run" }, { id: "wait" }],
    }));
    expect(view.steps.map((s) => s.state)).toEqual(["passed", "failed", "skipped", "running", "pending"]);
  });

  it("`disagree` reads `running`, NOT pending", () => {
    // It had no clause in the derivation, so a step whose gate disagreed was indistinguishable
    // from one never dispatched. `disagree` is one failed attempt while escalation continues;
    // `exhausted` is the terminal form.
    appendRecord(verdict({ step_id: "s1", verdict: "disagree" }) as never);
    expect(derivePlanState(readRecords(), plan()).steps[0].state).toBe("running");
  });
});

describe("the derivation", () => {
  it("keys on (plan_hash, step_id) — an OLD plan's rows do not alias onto new steps", () => {
    // The ledger is append-only, so after a recompile the old plan's rows remain. Keying on
    // step_id alone would read a fresh plan as already complete.
    const rows = [verdict({ plan_hash: OTHER, step_id: "s1", verdict: "agree" })];
    expect(deriveStepStates(rows, PH, [{ id: "s1" }])[0].state).toBe("pending");
    expect(deriveStepStates(rows, OTHER, [{ id: "s1" }])[0].state).toBe("passed");
  });

  it("`skipped` requires BOTH halves: optional: true AND a bypassed row", () => {
    const rows = [verdict({ step_id: "s1", verdict: "bypassed" })];
    expect(deriveStepStates(rows, PH, [{ id: "s1", optional: true }])[0].state).toBe("skipped");
    // `optional: true` with no bypassed row is still pending — a permission is not an event.
    expect(deriveStepStates([], PH, [{ id: "s1", optional: true }])[0].state).toBe("pending");
  });

  it("a bypassed row on a NON-optional step is a derivation ERROR, not a skip", () => {
    const rows = [verdict({ step_id: "s1", verdict: "bypassed" })];
    const view = deriveStepStates(rows, PH, [{ id: "s1" }]);
    expect(view[0].state).not.toBe("skipped");
    expect(view[0].error).toMatch(/does not mark it `optional: true`/);
  });

  it("a bypass error surfaces in the plan's blockers rather than being swallowed", () => {
    const view = derivePlanState([verdict({ step_id: "s1", verdict: "bypassed" })], plan());
    expect(view.blockers.join(" ")).toMatch(/was NOT honoured/);
  });

  it("a terminal verdict wins over a dispatch — `running` is only the absence of one", () => {
    const rows = [dispatch({ step_id: "s1" }), verdict({ step_id: "s1", verdict: "agree" })];
    expect(deriveStepStates(rows, PH, [{ id: "s1" }])[0].state).toBe("passed");
  });

  it("a verdict with no step_id (a solve re-rollout verdict) is ignored here", () => {
    const rows = [verdict({ problem_hash: "p1", verdict: "agree" })];
    expect(deriveStepStates(rows, PH, [{ id: "s1" }])[0].state).toBe("pending");
  });
});

// This is the guarantee that is ACTUALLY enforceable, and it had zero coverage. Rev 1 instead
// appended a `todo` row and asserted it could not move a step — but a todo row carries no step
// identity at all, so NO implementation could ever have honoured it and the test passed
// vacuously against everything.
describe("unforgeability — the LANE FILTER is the real defense", () => {
  it("a `simulated` verdict with the right (plan_hash, step_id) leaves the step PENDING", () => {
    // A Prova gym run exercising this loop appends simulated verdicts. Without the filter they
    // would mark real plan steps passed, defeating the lane separation inside the very
    // derivation it exists to protect.
    const rows = [verdict({ step_id: "s1", verdict: "agree", source: "simulated" })];
    expect(deriveStepStates(rows, PH, [{ id: "s1" }])[0].state).toBe("pending");
  });

  it("a `replay` verdict likewise does not count as progress", () => {
    const rows = [verdict({ step_id: "s1", verdict: "agree", source: "replay" })];
    expect(deriveStepStates(rows, PH, [{ id: "s1" }])[0].state).toBe("pending");
  });

  it("an ABSENT source counts as user, so pre-existing rows are not rewritten as un-progressed", () => {
    const rows = [{ type: "verdict", ts: ts(), plan_hash: PH, step_id: "s1", verdict: "agree" } as LedgerRecord];
    expect(deriveStepStates(rows, PH, [{ id: "s1" }])[0].state).toBe("passed");
  });

  it("a hand-appended `user` verdict DOES move the step — stated honestly", () => {
    // §4.4 concedes there is no per-kind authorization on `amico ledger append`, the product
    // agent holds unrestricted bash, and no actor identity exists at this layer. Asserting the
    // true property beats asserting a false one: the barrier is that forging `passed` requires
    // forging a GATE VERDICT, the same barrier that protects every fidelity claim in the system.
    const rows = [verdict({ step_id: "s1", verdict: "agree", source: "user" })];
    expect(deriveStepStates(rows, PH, [{ id: "s1" }])[0].state).toBe("passed");
  });
});

describe("the completion rule (§4.5)", () => {
  const twoSteps = plan({ steps: [{ id: "a" }, { id: "b" }] });

  it("complete <=> every step in {passed, skipped} AND every advisory closed", () => {
    const rows = [verdict({ step_id: "a", verdict: "agree" }), verdict({ step_id: "b", verdict: "agree" })];
    expect(derivePlanState(rows, twoSteps).state).toBe("complete");
  });

  it("an OPEN advisory keeps a fully-passed plan OUT of complete", () => {
    // This conjunct is where tier-2 critics get their teeth: they gate COMPLETION, never START.
    // Dropping it makes "all todos done" mean "the gates passed and we ignored every critic".
    const p = plan({ steps: [{ id: "a" }], advisories: [{ id: "adv-1", claim: "c" }] });
    const rows = [verdict({ step_id: "a", verdict: "agree" })];
    const view = derivePlanState(rows, p);
    expect(view.state).toBe("active");
    expect(view.open_advisories).toBe(1);
    expect(view.blockers.join(" ")).toMatch(/advisory "adv-1" is open/);
  });

  it("…and closing it completes the plan", () => {
    const p = plan({ steps: [{ id: "a" }], advisories: [{ id: "adv-1" }] });
    const rows = [verdict({ step_id: "a", verdict: "agree" }), todo({ id: "adv-1", state: "fixed" })];
    expect(derivePlanState(rows, p).state).toBe("complete");
  });

  it("a skipped optional step counts toward completion", () => {
    const p = plan({ steps: [{ id: "a" }, { id: "b", optional: true }] });
    const rows = [verdict({ step_id: "a", verdict: "agree" }), verdict({ step_id: "b", verdict: "bypassed" })];
    expect(derivePlanState(rows, p).state).toBe("complete");
  });

  it("gate exhaustion on any step is `stalled`", () => {
    const rows = [verdict({ step_id: "a", verdict: "agree" }), verdict({ step_id: "b", verdict: "exhausted" })];
    const view = derivePlanState(rows, twoSteps);
    expect(view.state).toBe("stalled");
    expect(view.blockers.join(" ")).toMatch(/step "b" failed/);
  });

  it("an exhausted replan budget is `stalled`", () => {
    const rows = [verdict({ step_id: "a", verdict: "agree" }), verdict({ step_id: "b", verdict: "agree" })];
    const view = derivePlanState(rows, twoSteps, { replans: 4 });
    expect(view.state).toBe("stalled");
    expect(view.blockers.join(" ")).toMatch(/replan budget \(3\) is exhausted/);
  });

  it("uses PLAN-scoped names, never the session-scoped FLEET_STATES", () => {
    // Rev 1 reused `settled`/`blocked`, which are shipped fleet SESSION states — including for
    // the same triggering event. Two authorities over one name.
    for (const rows of [[], [verdict({ step_id: "a", verdict: "exhausted" })]]) {
      expect(["active", "complete", "stalled"]).toContain(derivePlanState(rows, twoSteps).state);
    }
  });

  it("a plan with no steps at all does not read `complete` by vacuity", () => {
    // `steps.minItems: 1` makes this unreachable through compile, but the derivation should not
    // depend on the schema for a safety property.
    expect(derivePlanState([], plan({ steps: [] })).state).toBe("complete");
  });
});

describe("the todo doctrine", () => {
  const p = plan({ steps: [{ id: "a" }], advisories: [{ id: "adv-1" }] });

  it("resolves multiple rows per id LAST-TS-WINS", () => {
    const rows = [
      todo({ id: "adv-1", state: "fixed", ts: ts(1) }),
      todo({ id: "adv-1", state: "obsolete", ts: ts(3) }),
      todo({ id: "adv-1", state: "waived", reason: "later", ts: ts(2) }),
    ];
    expect(deriveAdvisories(rows, PH, p.advisories!)[0].state).toBe("obsolete");
  });

  it("fixed -> obsolete is legal: the fix turned out to be moot", () => {
    const rows = [todo({ id: "adv-1", state: "fixed", ts: ts(1) }), todo({ id: "adv-1", state: "obsolete", ts: ts(2) })];
    expect(deriveAdvisories(rows, PH, p.advisories!)[0].state).toBe("obsolete");
  });

  it("`open` is the ABSENCE of a row", () => {
    expect(deriveAdvisories([], PH, p.advisories!)[0].state).toBe("open");
  });

  it("carries the waive reason into the view, so waive-spam is visible", () => {
    const rows = [todo({ id: "adv-1", state: "waived", reason: "out of scope for this slice" })];
    expect(deriveAdvisories(rows, PH, p.advisories!)[0].reason).toMatch(/out of scope/);
  });

  it("a todo row for ANOTHER plan does not close this plan's advisory", () => {
    const rows = [todo({ id: "adv-1", state: "fixed", plan_hash: OTHER })];
    expect(deriveAdvisories(rows, PH, p.advisories!)[0].state).toBe("open");
  });

  it("a `simulated` todo row does not close an advisory either", () => {
    const rows = [todo({ id: "adv-1", state: "fixed", source: "simulated" })];
    expect(deriveAdvisories(rows, PH, p.advisories!)[0].state).toBe("open");
  });

  it("a row for an id the plan never declared does not appear in the view", () => {
    // The declared list is the completion rule's DENOMINATOR, so it comes from the plan, never
    // from whatever rows happen to exist.
    const rows = [todo({ id: "invented", state: "fixed" })];
    const view = deriveAdvisories(rows, PH, p.advisories!);
    expect(view.map((a) => a.id)).toEqual(["adv-1"]);
  });
});
