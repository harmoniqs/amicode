// Tier dispatch (fleet spec §6.3 Rev 5) — the `dispatch` ledger stanza plus the
// aggregator that turns those rows into m*(s) = argmin_m c_m / p_m(s), with the
// escalation ladder as the standing fallback.
//
// The load-bearing block in this file is "the sim/hw boundary": simulated rows are
// admissible here (opt-in) but must NEVER route hardware work, and the leak path is
// the FALLBACK key, not the primary. See that describe() before changing any matcher.
// Run: pnpm --filter @amicode/amico-run test ledger_dispatch
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRecord, readRecords, type DispatchRecord, type LedgerRecord } from "../src/ledger.js";
import { K_MIN, N_HIGH } from "../src/ledger_query.js";
import {
  aggregateDispatch,
  dispatchTable,
  escalationLadder,
  ladderCost,
  laneOf,
  rankDispatchConfidence,
  FRONTIER_RUNG,
} from "../src/ledger_dispatch.js";
import { ledgerVerb } from "../src/ledger_verb.js";

const HAIKU = "anthropic/claude-haiku-4-5";
const SONNET = "anthropic/claude-sonnet-5";
const OPUS48 = "anthropic/claude-opus-4-8";
const OPUS5 = "anthropic/claude-opus-5";

/** A dispatch row with sane defaults; override what a case is about. */
function row(over: Partial<DispatchRecord> = {}): DispatchRecord {
  return {
    type: "dispatch",
    ts: "2026-07-24T12:00:00Z",
    task_type: "author-script",
    work_id: "h1",
    model: HAIKU,
    variant: "high",
    gate: "re-rollout",
    pass: true,
    tokens: 1000,
    attempt_index: 1,
    source: "user",
    ...over,
  };
}
const rows = (n: number, over: Partial<DispatchRecord> = {}): DispatchRecord[] =>
  Array.from({ length: n }, () => row(over));

// ── the record contract ───────────────────────────────────────────────────────────
describe("DispatchRecord — the 7th ledger kind", () => {
  let dir: string;
  const prevEnv = process.env.AMICO_LEDGER;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ledger-dispatch-"));
    process.env.AMICO_LEDGER = join(dir, "runs.jsonl");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.AMICO_LEDGER;
    else process.env.AMICO_LEDGER = prevEnv;
  });

  it("appends and round-trips through the ledger (validate-on-write covers it for free)", () => {
    const rec = row({ tokens: 1234, work_id: "structhash-abc" });
    appendRecord(rec);
    const back = readRecords();
    expect(back).toHaveLength(1);
    expect(back[0]).toEqual(rec);
  });

  it("appends alongside the other kinds — the union stayed a union", () => {
    appendRecord(row());
    appendRecord({ type: "fallback", ts: "t", from_tier: "spec", reason: "custom objective kind" });
    appendRecord(row({ model: OPUS5, variant: "default" }));
    const back = readRecords();
    expect(back.map((r) => r.type)).toEqual(["dispatch", "fallback", "dispatch"]);
  });

  it("experiment-row conventions append as specified (attempt_index = 1, tokens = 0)", () => {
    const rec = row({ task_type: "experiment-sim", work_id: "t1-fit", tokens: 0, attempt_index: 1, source: "simulated" });
    expect(() => appendRecord(rec)).not.toThrow();
  });

  // A malformed row must never land: an honest ledger has no garbage, and here a
  // mislabelled row is not cosmetic — a lane-less `experiment` task_type is exactly
  // how simulated pass-rates would reach hardware routing.
  it.each([
    ["missing work_id", (r: Record<string, unknown>) => delete r.work_id],
    ["missing task_type", (r: Record<string, unknown>) => delete r.task_type],
    ["missing pass", (r: Record<string, unknown>) => delete r.pass],
    ["missing attempt_index", (r: Record<string, unknown>) => delete r.attempt_index],
    ["missing tokens", (r: Record<string, unknown>) => delete r.tokens],
    ["lane-less task_type (a bare `experiment`)", (r: Record<string, unknown>) => (r.task_type = "experiment")],
    ["unknown task_type", (r: Record<string, unknown>) => (r.task_type = "vibes")],
    ["model without a provider prefix", (r: Record<string, unknown>) => (r.model = "claude-haiku-4-5")],
    ["empty variant (model/variant co-stamping)", (r: Record<string, unknown>) => (r.variant = "")],
    ["attempt_index below 1", (r: Record<string, unknown>) => (r.attempt_index = 0)],
    ["negative tokens", (r: Record<string, unknown>) => (r.tokens = -1)],
    ["non-boolean pass", (r: Record<string, unknown>) => (r.pass = "yes")],
    ["unknown source", (r: Record<string, unknown>) => (r.source = "guessed")],
    ["an unknown extra key", (r: Record<string, unknown>) => (r.tier = "spec")],
  ])("rejects a malformed record on append: %s", (_label, mutate) => {
    const bad = row() as unknown as Record<string, unknown>;
    mutate(bad);
    expect(() => appendRecord(bad as unknown as DispatchRecord)).toThrow(/invalid ledger record/);
    expect(readRecords()).toHaveLength(0);
  });

  it("dispatchTable reads the on-disk ledger (the thin I/O wrapper)", () => {
    for (const r of rows(3, { pass: true })) appendRecord(r);
    const res = dispatchTable({ work_id: "h1", task_type: "author-script" });
    expect(res.cells).toHaveLength(1);
    expect(res.cells[0].n).toBe(3);
    expect(res.selection?.model).toBe(HAIKU);
  });
});

// ── lanes ─────────────────────────────────────────────────────────────────────────
describe("the lane partition", () => {
  it("carries the sim/hw axis in the taxonomy itself", () => {
    expect(laneOf("experiment-sim")).toBe("sim");
    expect(laneOf("experiment-hw")).toBe("hw");
    for (const t of ["plan", "author-script", "implement-slice", "review", "insight", "bookkeeping", "triage", "converse"]) {
      expect(laneOf(t)).toBe("authoring");
    }
  });
});

// ── the escalation ladder (§6.2) ──────────────────────────────────────────────────
describe("escalation ladder", () => {
  it("escalates one rung at a time from the stamp", () => {
    expect(escalationLadder(HAIKU)).toEqual([SONNET, OPUS48, OPUS5]);
    expect(escalationLadder(SONNET)).toEqual([OPUS48, OPUS5]);
    expect(escalationLadder(OPUS48)).toEqual([OPUS5]);
  });

  // The rung skip: `opus-4-8 → frontier` collapsed to ONE rung before fable-class
  // landed, because the frontier rung's model id equalled the current one.
  it("SKIPS a rung whose model id equals the current one", () => {
    expect(escalationLadder(SONNET, OPUS48)).toEqual([OPUS48]);
    expect(escalationLadder(OPUS48, OPUS48)).toEqual([]);
  });

  it("an empty ladder means the stamp IS the top reachable rung (gate exhaustion, not replan)", () => {
    expect(escalationLadder(OPUS5)).toEqual([]);
    expect(FRONTIER_RUNG).toBe(OPUS5);
  });

  it("an unknown model id is treated as below frontier — it escalates straight to frontier", () => {
    expect(escalationLadder("some/experimental-model")).toEqual([OPUS5]);
  });

  it("ladderCost is monotone in ladder position and prices unknown models as frontier-class", () => {
    expect(ladderCost(HAIKU)).toBeLessThan(ladderCost(SONNET));
    expect(ladderCost(SONNET)).toBeLessThan(ladderCost(OPUS48));
    expect(ladderCost(OPUS48)).toBeLessThan(ladderCost(OPUS5));
    expect(ladderCost("some/experimental-model")).toBe(ladderCost(OPUS5));
  });
});

// ── the rubric: one set of bands, imported from ledger_query ──────────────────────
describe("confidence rubric (mirrors ledger_query's bands)", () => {
  it("sparse (< K_MIN) is low", () => {
    expect(rankDispatchConfidence(K_MIN - 1, 0, true)).toBe("low");
  });
  it("wide relative IQR is low even at high n", () => {
    expect(rankDispatchConfidence(N_HIGH + 5, 1.6, true)).toBe("low");
  });
  it("tight + n >= N_HIGH + observed cost is high", () => {
    expect(rankDispatchConfidence(N_HIGH, 0.1, true)).toBe("high");
  });
  it("INTERIM CAP: an unobserved c_m can never claim high (the cost half is unmeasured)", () => {
    expect(rankDispatchConfidence(N_HIGH, 0.1, false)).toBe("medium");
    expect(rankDispatchConfidence(N_HIGH, null, false)).toBe("medium");
  });
  it("in between is medium", () => {
    expect(rankDispatchConfidence(K_MIN, 0.1, true)).toBe("medium");
  });
});

// ── primary/fallback at the K_MIN boundary ────────────────────────────────────────
describe("key selection at the K_MIN boundary", () => {
  it(`K_MIN primary rows keep the PRIMARY key (K_MIN = ${K_MIN})`, () => {
    const recs: LedgerRecord[] = [
      ...rows(K_MIN, { work_id: "h1" }),
      ...rows(4, { work_id: "h2" }), // same task_type, other work — the fallback bucket
    ];
    const res = aggregateDispatch(recs, { work_id: "h1", task_type: "author-script" });
    expect(res.key).toBe("primary");
    expect(res.cells[0].key).toBe("primary");
    expect(res.cells[0].n).toBe(K_MIN);
  });

  it("one row below K_MIN relaxes to the task_type FALLBACK key", () => {
    const recs: LedgerRecord[] = [
      ...rows(K_MIN - 1, { work_id: "h1", pass: false }),
      ...rows(3, { work_id: "h2", pass: true }),
    ];
    const res = aggregateDispatch(recs, { work_id: "h1", task_type: "author-script" });
    expect(res.key).toBe("fallback");
    expect(res.cells[0].key).toBe("fallback");
    expect(res.cells[0].n).toBe(K_MIN - 1 + 3);
    expect(res.cells[0].passes).toBe(3);
  });

  it("a sparse cell with NOTHING to relax into stays primary, insufficient, and hands back the ladder", () => {
    const res = aggregateDispatch(rows(1, { work_id: "h1" }), {
      work_id: "h1",
      task_type: "author-script",
      stamp: HAIKU,
    });
    expect(res.cells[0].n).toBe(1);
    expect(res.cells[0].confidence).toBe("low");
    expect(res.cells[0].eligible).toBe(false);
    expect(res.selection).toBeNull();
    expect(res.ladder_fallback).toBe(true);
    expect(res.ladder).toEqual([SONNET, OPUS48, OPUS5]);
  });

  it("relaxation never happens when the fallback bucket is no larger than the primary", () => {
    const recs = rows(1, { work_id: "h1", task_type: "author-script" });
    const res = aggregateDispatch(recs, { work_id: "h1", task_type: "author-script" });
    expect(res.cells[0].key).toBe("primary");
  });

  it("no rows at all → key `none`, no selection", () => {
    const res = aggregateDispatch([], { work_id: "nope", task_type: "plan", stamp: SONNET });
    expect(res.key).toBe("none");
    expect(res.cells).toEqual([]);
    expect(res.selection).toBeNull();
    expect(res.ladder).toEqual([OPUS48, OPUS5]);
  });
});

// ── first-attempt-only p_m(s) ─────────────────────────────────────────────────────
describe("p_m(s) counts FIRST-ATTEMPT samples only", () => {
  it("escalated attempts are excluded and reported, not silently dropped", () => {
    const recs: LedgerRecord[] = [
      ...rows(2, { pass: true, attempt_index: 1 }),
      ...rows(1, { pass: false, attempt_index: 1 }),
      // escalated retries: an escalated tier sees a biased task distribution (§6.2)
      ...rows(4, { pass: true, attempt_index: 2 }),
      ...rows(2, { pass: true, attempt_index: 3 }),
    ];
    const res = aggregateDispatch(recs, { work_id: "h1", task_type: "author-script" });
    expect(res.cells[0].n).toBe(3);
    expect(res.cells[0].passes).toBe(2);
    expect(res.cells[0].p).toBeCloseTo(2 / 3, 10);
    expect(res.excluded.escalated).toBe(6);
  });

  it("replay rows are never evidence", () => {
    const recs: LedgerRecord[] = [...rows(3, { source: "user" }), ...rows(5, { source: "replay" })];
    const res = aggregateDispatch(recs, { work_id: "h1", task_type: "author-script" });
    expect(res.cells[0].n).toBe(3);
    expect(res.excluded.replay).toBe(5);
  });
});

// ── m*(s) = argmin c_m / p_m(s) ───────────────────────────────────────────────────
describe("m*(s) selection", () => {
  it("picks the lowest cost per verified success, not the cheapest model", () => {
    const recs: LedgerRecord[] = [
      // haiku: cheap but passes half the time → 1000 / 0.5 = 2000
      ...rows(2, { model: HAIKU, tokens: 1000, pass: true }),
      ...rows(2, { model: HAIKU, tokens: 1000, pass: false }),
      // opus-5: dear but always passes → 4000 / 1.0 = 4000
      ...rows(4, { model: OPUS5, tokens: 4000, pass: true }),
    ];
    const res = aggregateDispatch(recs, { work_id: "h1", task_type: "author-script" });
    expect(res.selection?.model).toBe(HAIKU);
    expect(res.selection?.cost_per_success).toBeCloseTo(2000, 6);
    expect(res.cells.map((c) => c.model)).toEqual([HAIKU, OPUS5]); // sorted by c/p
  });

  it("a cheap model that mostly FAILS is not cheap — the frontier cell wins", () => {
    const recs: LedgerRecord[] = [
      ...rows(1, { model: HAIKU, tokens: 1000, pass: true }),
      ...rows(9, { model: HAIKU, tokens: 1000, pass: false }), // p = 0.1 → c/p = 10000
      ...rows(5, { model: OPUS5, tokens: 4000, pass: true }), // c/p = 4000
    ];
    const res = aggregateDispatch(recs, { work_id: "h1", task_type: "author-script" });
    expect(res.selection?.model).toBe(OPUS5);
    expect(res.confidence).toBe("high"); // n >= N_HIGH, tight token spread, observed c_m
  });

  it("a cell that has NEVER passed is infinitely expensive and never selected", () => {
    const recs: LedgerRecord[] = [
      ...rows(4, { model: HAIKU, pass: false }),
      ...rows(2, { model: OPUS5, tokens: 9000, pass: true }),
    ];
    const res = aggregateDispatch(recs, { work_id: "h1", task_type: "author-script" });
    const haiku = res.cells.find((c) => c.model === HAIKU)!;
    expect(haiku.cost_per_success).toBe(Number.POSITIVE_INFINITY);
    expect(haiku.eligible).toBe(false);
    expect(res.selection?.model).toBe(OPUS5);
  });

  it("cells are (model × variant): the same model at two efforts is two cells", () => {
    const recs: LedgerRecord[] = [
      ...rows(3, { model: OPUS5, variant: "low", tokens: 1000 }),
      ...rows(3, { model: OPUS5, variant: "high", tokens: 6000 }),
    ];
    const all = aggregateDispatch(recs, { work_id: "h1", task_type: "author-script" });
    expect(all.cells).toHaveLength(2);
    const restricted = aggregateDispatch(recs, { work_id: "h1", task_type: "author-script", variant: "high" });
    expect(restricted.cells).toHaveLength(1);
    expect(restricted.cells[0].variant).toBe("high");
  });

  it("no sufficient cell at the top reachable rung → empty ladder (gate exhaustion)", () => {
    const res = aggregateDispatch(rows(1, { model: OPUS48 }), {
      work_id: "h1",
      task_type: "author-script",
      stamp: OPUS48,
    });
    expect(res.ladder_fallback).toBe(true);
    // frontier collapsed onto the stamp: no distinct rung is left to escalate to
    expect(aggregateDispatch([], { work_id: "h1", task_type: "plan", stamp: OPUS48 }, { frontier: OPUS48 }).ladder).toEqual([]);
  });
});

// ── spread-aware confidence over the cost-per-success estimates ───────────────────
describe("IQR-band confidence on cells", () => {
  it("tight token spread at n >= N_HIGH → high", () => {
    const res = aggregateDispatch(rows(N_HIGH, { tokens: 1000, pass: true }), { work_id: "h1", task_type: "author-script" });
    expect(res.cells[0].cost_rel_iqr).toBe(0);
    expect(res.cells[0].confidence).toBe("high");
  });

  it("wide token spread demotes to low even at high n (relIQR > IQR_WIDE)", () => {
    const recs: LedgerRecord[] = [...rows(3, { tokens: 100 }), ...rows(3, { tokens: 5000 })];
    const res = aggregateDispatch(recs, { work_id: "h1", task_type: "author-script" });
    expect(res.cells[0].cost_rel_iqr!).toBeGreaterThan(1.5);
    expect(res.cells[0].confidence).toBe("low");
    expect(res.selection).toBeNull(); // insufficient → the ladder governs
  });

  it("K_MIN..N_HIGH with a tight spread is medium", () => {
    const res = aggregateDispatch(rows(K_MIN, { tokens: 1000 }), { work_id: "h1", task_type: "author-script" });
    expect(res.cells[0].confidence).toBe("medium");
    expect(res.cells[0].eligible).toBe(true);
  });
});

// ── cost estimation: experiment rows carry tokens = 0 ─────────────────────────────
describe("c_m estimation excludes experiment rows", () => {
  it("an experiment-only cell is priced by ladder position, and cannot claim high", () => {
    const recs = rows(N_HIGH + 1, { task_type: "experiment-sim", work_id: "t1-fit", tokens: 0, source: "simulated" });
    const res = aggregateDispatch(recs, { work_id: "t1-fit", task_type: "experiment-sim" }, { include_simulated: true });
    expect(res.cells[0].cost_observed).toBe(false);
    expect(res.cells[0].cost).toBe(ladderCost(HAIKU));
    expect(res.cells[0].confidence).toBe("medium");
  });

  it("a lab cell inherits c_m from the SAME MODEL's authoring dispatches (Rev 4.1)", () => {
    const recs: LedgerRecord[] = [
      ...rows(3, { task_type: "experiment-hw", work_id: "t1-fit", tokens: 0, pass: true }),
      // the ladder's own authoring dispatches supply the price
      ...rows(4, { task_type: "author-script", work_id: "h1", tokens: 800 }),
    ];
    const res = aggregateDispatch(recs, { work_id: "t1-fit", task_type: "experiment-hw" });
    expect(res.cells[0].cost_observed).toBe(true);
    expect(res.cells[0].cost).toBe(800);
    // …and the authoring rows priced it WITHOUT ever entering the hardware pass-rate
    expect(res.cells[0].n).toBe(3);
    expect(res.cells[0].lane).toBe("hw");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// THE SIM/HW BOUNDARY (fleet §6.3 Rev 5) — the rule this whole module exists to keep.
// Simulated pass-rates must NEVER route real hardware work. The leak path is the
// FALLBACK key, not the primary: relax-to-coarser-key is where difficulty populations
// get mixed, exactly as `structure_hash`'s goal-blindness mixed CZ with X.
// ═════════════════════════════════════════════════════════════════════════════════
describe("the sim/hw boundary", () => {
  // Same experiment kind on the simulator and on the board — the work_id string is
  // IDENTICAL, which is precisely why the primary key must be lane-scoped too.
  const SIM_ROWS = rows(6, {
    task_type: "experiment-sim",
    work_id: "t1-fit",
    model: HAIKU,
    variant: "default",
    pass: true,
    tokens: 0,
    source: "simulated",
  });
  const HW_SPARSE = rows(1, {
    task_type: "experiment-hw",
    work_id: "t1-fit",
    model: HAIKU,
    variant: "default",
    pass: false,
    tokens: 0,
    source: "user",
  });

  it("simulated rows ARE counted in the sim lane when opted in (ledger_query's filter stays untouched)", () => {
    const res = aggregateDispatch([...SIM_ROWS], { work_id: "t1-fit", task_type: "experiment-sim" }, { include_simulated: true });
    expect(res.cells).toHaveLength(1);
    expect(res.cells[0].n).toBe(6);
    expect(res.cells[0].p).toBe(1);
    expect(res.selection?.model).toBe(HAIKU);
    expect(res.include_simulated).toBe(true);
  });

  it("without the opt-in, simulated evidence is excluded WITH visible provenance", () => {
    const res = aggregateDispatch([...SIM_ROWS], { work_id: "t1-fit", task_type: "experiment-sim" });
    expect(res.cells).toEqual([]);
    expect(res.key).toBe("none");
    expect(res.excluded.simulated).toBe(6);
  });

  // ── THE ASSERTION ─────────────────────────────────────────────────────────────
  it("a SPARSE experiment-hw cell does NOT fall back into the sim-inclusive bucket", () => {
    const res = aggregateDispatch(
      [...SIM_ROWS, ...HW_SPARSE],
      { work_id: "t1-fit", task_type: "experiment-hw", stamp: HAIKU },
      { include_simulated: true }, // the opt-in is ON: it must still not reach the hw lane
    );
    // exactly one cell, and it saw ONLY the single hardware row (not 1 + 6 = 7)
    expect(res.cells).toHaveLength(1);
    expect(res.lane).toBe("hw");
    expect(res.cells.every((c) => c.lane === "hw")).toBe(true);
    expect(res.cells[0].n).toBe(1);
    expect(res.cells[0].passes).toBe(0);
    expect(res.cells[0].p).toBe(0); // the 6 simulated passes did not leak in
    // sparse and unrelaxable → the escalation ladder governs, exactly as specified
    expect(res.cells[0].eligible).toBe(false);
    expect(res.selection).toBeNull();
    expect(res.ladder_fallback).toBe(true);
    expect(res.ladder).toEqual([SONNET, OPUS48, OPUS5]);
  });

  it("a sparse experiment-hw cell relaxes WITHIN HARDWARE ROWS ONLY", () => {
    const otherHw = rows(3, {
      task_type: "experiment-hw",
      work_id: "rabi-amp", // different work, same lane → a legitimate fallback bucket
      model: HAIKU,
      variant: "default",
      pass: true,
      tokens: 0,
      source: "user",
    });
    const res = aggregateDispatch(
      [...SIM_ROWS, ...HW_SPARSE, ...otherHw],
      { work_id: "t1-fit", task_type: "experiment-hw", stamp: HAIKU },
      { include_simulated: true },
    );
    expect(res.cells).toHaveLength(1);
    expect(res.cells[0].key).toBe("fallback");
    expect(res.cells[0].n).toBe(4); // 1 + 3 hardware rows — NOT 10 with the sim rows
    expect(res.cells[0].passes).toBe(3);
    expect(res.cells[0].p).toBeCloseTo(0.75, 10);
    expect(res.lane).toBe("hw");
  });

  it("a simulated-source row mislabelled OUTSIDE the sim lane is refused outright", () => {
    // Second line of defence: even if such a row reached the ledger, it can never
    // license hardware routing.
    const mislabelled = rows(4, {
      task_type: "experiment-hw",
      work_id: "t1-fit",
      variant: "default",
      pass: true,
      tokens: 0,
      source: "simulated",
    });
    const res = aggregateDispatch([...mislabelled, ...HW_SPARSE], { work_id: "t1-fit", task_type: "experiment-hw" }, { include_simulated: true });
    expect(res.excluded.cross_lane).toBe(4);
    expect(res.cells[0].n).toBe(1);
    expect(res.selection).toBeNull();
  });

  it("the authoring lane is likewise unreachable from experiment rows", () => {
    const recs: LedgerRecord[] = [
      ...rows(6, { task_type: "experiment-sim", work_id: "h1", pass: true, tokens: 0, source: "simulated" }),
      ...rows(1, { task_type: "author-script", work_id: "h1", pass: false }),
    ];
    const res = aggregateDispatch(recs, { work_id: "h1", task_type: "author-script" }, { include_simulated: true });
    expect(res.cells).toHaveLength(1);
    expect(res.cells[0].lane).toBe("authoring");
    expect(res.cells[0].n).toBe(1);
  });
});

// ── the verb surface ─────────────────────────────────────────────────────────────
describe("amico ledger dispatch", () => {
  let dir: string;
  const prevEnv = process.env.AMICO_LEDGER;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ledger-dispatch-verb-"));
    process.env.AMICO_LEDGER = join(dir, "runs.jsonl");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.AMICO_LEDGER;
    else process.env.AMICO_LEDGER = prevEnv;
  });

  it("routes to the aggregator and returns the table", () => {
    for (const r of rows(4, { tokens: 1000, pass: true })) appendRecord(r);
    const r = ledgerVerb(["dispatch", "--work-id", "h1", "--task-type", "author-script", "--stamp", HAIKU]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      verb: "ledger",
      subcommand: "dispatch",
      work_id: "h1",
      task_type: "author-script",
      lane: "authoring",
      key: "primary",
    });
  });

  it("--include-simulated is opt-in at the CLI too", () => {
    for (const r of rows(4, { task_type: "experiment-sim", work_id: "t1-fit", tokens: 0, source: "simulated" })) appendRecord(r);
    const off = ledgerVerb(["dispatch", "--work-id", "t1-fit", "--task-type", "experiment-sim"]);
    expect((off.json as { cells: unknown[] }).cells).toEqual([]);
    const on = ledgerVerb(["dispatch", "--work-id", "t1-fit", "--task-type", "experiment-sim", "--include-simulated"]);
    expect((on.json as { cells: unknown[] }).cells).toHaveLength(1);
  });

  it("missing required flags → usage error, exit 64", () => {
    const r = ledgerVerb(["dispatch", "--work-id", "h1"]);
    expect(r.code).toBe(64);
    expect((r.json as { error: string }).error).toMatch(/--task-type/);
  });

  it("the verb usage advertises the dispatch subcommand", () => {
    const r = ledgerVerb([]);
    expect(r.code).toBe(64);
    expect((r.json as { usage: string }).usage).toContain("ledger dispatch");
  });
});
