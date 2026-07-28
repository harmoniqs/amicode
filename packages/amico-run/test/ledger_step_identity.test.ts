// Verdict/dispatch rows can name a plan step.
//
// REGRESSION GUARD for the defect class of the max_solves bug (a6b023a): a derivation
// keyed on a field the schema forbids. The deliberation spec derived plan-step state
// from VerdictRecord(step_id) while the verdict branch was additionalProperties:false
// with no step_id — so a row carrying one threw on append and a row without one never
// matched, making every step read `pending` forever. Four independent spec critics
// found it; this test is what keeps it fixed.
//
// Plan: plan-20260728-104500 Task 2.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRecord, readRecords } from "../src/ledger.js";

const ts = () => new Date().toISOString();
const row = (i = 0) => readRecords()[i] as unknown as Record<string, unknown>;

describe("plan-step identity on verdict/dispatch rows", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ledger-step-"));
    process.env.AMICO_LEDGER = join(dir, "runs.jsonl");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.AMICO_LEDGER;
  });

  it("a verdict row carrying plan_hash + step_id appends", () => {
    appendRecord({
      type: "verdict", ts: ts(), plan_hash: "abc", step_id: "s2", verdict: "agree", source: "user",
    } as never);
    expect(row().step_id).toBe("s2");
    expect(row().plan_hash).toBe("abc");
  });

  it("problem_hash stays REQUIRED when step_id is absent (existing solve-shaped rows)", () => {
    expect(() => appendRecord({ type: "verdict", ts: ts(), verdict: "agree" } as never)).toThrow(/problem_hash/);
  });

  it("verdict gains `exhausted`, so per-step gate exhaustion has a carrier", () => {
    appendRecord({
      type: "verdict", ts: ts(), plan_hash: "abc", step_id: "s3", verdict: "exhausted", source: "user",
    } as never);
    expect(row().verdict).toBe("exhausted");
  });

  it("a dispatch row can name a step", () => {
    appendRecord({
      type: "dispatch", ts: ts(), task_type: "author-script", work_id: "wid",
      model: "anthropic/claude-opus-5", variant: "high", gate: "re-rollout",
      pass: true, tokens: 10, attempt_index: 1, source: "user",
      plan_hash: "abc", step_id: "s2",
    } as never);
    expect(row().step_id).toBe("s2");
  });

  it("an EXISTING solve-shaped verdict row still validates (no regression)", () => {
    appendRecord({
      type: "verdict", ts: ts(), problem_hash: "ph", verdict: "agree", fidelity_rerolled: 0.999,
    } as never);
    expect(readRecords()).toHaveLength(1);
  });

  it("source is available on verdict rows, so simulated gym verdicts are separable", () => {
    appendRecord({
      type: "verdict", ts: ts(), plan_hash: "abc", step_id: "s1", verdict: "agree", source: "simulated",
    } as never);
    expect(row().source).toBe("simulated");
  });
});
