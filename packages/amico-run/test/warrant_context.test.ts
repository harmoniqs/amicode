// WarrantContext assembly — the only I/O in the warrant path (spec §5.1).
// The interesting cases are all fail-closed: off by default, no ledger means no
// warrants (so gated launches refuse), and an unsizeable script stays UNDEFINED
// rather than falling back to SMALL (§4.4).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleWarrantContext, sizeClassFor, solvesUnderPlan, warrantsEnabled } from "../src/warrant_context.js";

const SIZEABLE = `using Piccolo\nN = 100\nlevels = [3, 3]\n`;

describe("warrantsEnabled — the whole flag surface", () => {
  it("off unless explicitly enabled", () => {
    for (const v of [undefined, "", "0", "false", "no", "off", "maybe"]) {
      expect(warrantsEnabled({ AMICO_WARRANTS: v } as NodeJS.ProcessEnv), String(v)).toBe(false);
    }
  });
  it("on for 1/true/yes, case-insensitively", () => {
    for (const v of ["1", "true", "TRUE", "yes", " Yes "]) {
      expect(warrantsEnabled({ AMICO_WARRANTS: v } as NodeJS.ProcessEnv), v).toBe(true);
    }
  });
  it("returns undefined context when off — which disarms the gate step entirely", () => {
    expect(assembleWarrantContext({ scriptText: SIZEABLE, env: {} as NodeJS.ProcessEnv })).toBeUndefined();
  });
});

describe("sizeClassFor — never falls back to SMALL", () => {
  it("sizes a resolvable script", () => {
    expect(sizeClassFor(SIZEABLE)).toBeDefined();
  });
  it("UNRESOLVED levels → undefined, not SMALL (§4.4)", () => {
    // estimate.ts would internally leave knot_point_state_dim at 1 here and size it
    // SMALL. That is the silent widening path; the assembler must not reproduce it.
    expect(sizeClassFor(`using Piccolo\nN = 100\n`)).toBeUndefined();
  });
  it("missing N → undefined rather than a crash", () => {
    expect(sizeClassFor(`using Piccolo\nlevels = [3, 3]\n`)).toBeUndefined();
  });
  it("empty script (a problem_spec launch) → undefined", () => {
    expect(sizeClassFor("")).toBeUndefined();
    expect(sizeClassFor("   \n ")).toBeUndefined();
  });
  it("a bigger problem sizes larger than a small one", () => {
    const small = sizeClassFor(`N = 2\nlevels = [2]\n`);
    const big = sizeClassFor(`N = 500\nlevels = [5, 5, 5]\n`);
    expect(small).toBe("SMALL");
    expect(big).toBe("MEDIUM");
  });
});

describe("solvesUnderPlan", () => {
  it("counts only solve rows for that plan", () => {
    const rows = [
      { type: "solve", plan_hash: "a" },
      { type: "solve", plan_hash: "a" },
      { type: "solve", plan_hash: "b" },
      { type: "solve" },
      { type: "approval", plan_hash: "a" },
    ];
    expect(solvesUnderPlan("a", rows)).toBe(2);
    expect(solvesUnderPlan("zzz", rows)).toBe(0);
  });
});

describe("assembleWarrantContext with a real ledger", () => {
  let dir: string;
  const prev = process.env.AMICO_LEDGER;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "warrant-ctx-"));
    process.env.AMICO_LEDGER = join(dir, "runs.jsonl");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.AMICO_LEDGER;
    else process.env.AMICO_LEDGER = prev;
  });

  const ON = { AMICO_WARRANTS: "1" } as NodeJS.ProcessEnv;

  it("a MISSING ledger yields no approvals — fail closed, not fail open", () => {
    const ctx = assembleWarrantContext({ scriptText: SIZEABLE, env: ON });
    expect(ctx).toBeDefined();
    expect(ctx!.approvals).toEqual([]);
  });

  it("an UNREADABLE ledger also yields no approvals rather than throwing", () => {
    writeFileSync(process.env.AMICO_LEDGER!, "{not json\n");
    const ctx = assembleWarrantContext({ scriptText: SIZEABLE, env: ON });
    expect(ctx).toBeDefined();
    expect(ctx!.approvals).toEqual([]);
  });

  it("picks up approval rows and counts solves under the plan", () => {
    const rows = [
      { type: "approval", ts: "t", plan_hash: "p1", bounds: { max_solves: 4 }, expires_at: "t2", issued_by: "user:cli" },
      { type: "solve", ts: "t", plan_hash: "p1", structure_hash: "s", problem_hash: "h", kind: "control", tier: "spec", summary: {}, source: "user", outcome: {} },
    ];
    writeFileSync(process.env.AMICO_LEDGER!, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const ctx = assembleWarrantContext({ scriptText: SIZEABLE, planHash: "p1", env: ON });
    expect(ctx!.approvals).toHaveLength(1);
    expect(ctx!.solvesSoFar).toBe(1);
  });

  it("device defaults to none — solves are simulator-only today", () => {
    expect(assembleWarrantContext({ scriptText: SIZEABLE, env: ON })!.device).toBe("none");
  });
});
