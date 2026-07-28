// The three deliberation ledger kinds: spec_review, plan_compiled, todo.
//
// Every free-text field is maxLength-capped on purpose. The spec_review row carries
// per-lens reasons sourced from a subprocess's stderr, and appendRecord THROWS above
// PIPE_BUF (4096) — which would happen AFTER the model spend, losing the whole review.
// Finding bodies therefore live in a sidecar and the row carries only a digest.
//
// Plan: plan-20260728-104500 Task 3.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRecord, readRecords } from "../src/ledger.js";

const ts = () => new Date().toISOString();
const row = (i = 0) => readRecords()[i] as unknown as Record<string, unknown>;
const H = "a".repeat(64);

const review = (over: Record<string, unknown> = {}) => ({
  type: "spec_review", ts: ts(), spec_id: "spec-1", design_hash: H,
  rounds: 1, review_verdict: "approved-mechanical",
  lens_registry_version: "1", lens_status: [{ lens: "schema", status: "ran" }],
  critics: [], findings_count: 0, blocking_count: 0,
  findings_sha256: "b".repeat(64), findings_ref: ".review/x.json", source: "user",
  ...over,
});

describe("deliberation ledger kinds", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ledger-delib-"));
    process.env.AMICO_LEDGER = join(dir, "runs.jsonl");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.AMICO_LEDGER;
  });

  describe("spec_review", () => {
    it("appends, and critics: [] round-trips as PRESENT-and-empty (the offline sentinel)", () => {
      appendRecord(review() as never);
      expect(row().critics).toEqual([]);
      expect("critics" in row()).toBe(true); // absent would be indistinguishable from an old writer
    });
    it("rejects an out-of-enum review_verdict", () => {
      expect(() => appendRecord(review({ review_verdict: "fine" }) as never)).toThrow();
    });
    it("accepts every legal review_verdict", () => {
      for (const v of ["approved", "approved-mechanical", "degraded", "blocking", "exhausted"]) {
        appendRecord(review({ review_verdict: v }) as never);
      }
      expect(readRecords()).toHaveLength(5);
    });
    it("rejects rounds outside 1..3 (the round budget is the schema's business too)", () => {
      expect(() => appendRecord(review({ rounds: 4 }) as never)).toThrow();
      expect(() => appendRecord(review({ rounds: 0 }) as never)).toThrow();
    });
    it("caps a lens reason, so a subprocess's stderr cannot push the row past PIPE_BUF", () => {
      expect(() =>
        appendRecord(review({ lens_status: [{ lens: "api", status: "skipped", reason: "x".repeat(500) }] }) as never),
      ).toThrow();
    });
    it("rejects an out-of-enum lens status", () => {
      expect(() =>
        appendRecord(review({ lens_status: [{ lens: "schema", status: "probably-fine" }] }) as never),
      ).toThrow();
    });
    it("enforces the provider/model-id shape on a critic", () => {
      expect(() => appendRecord(review({ critics: [{ model: "opus-5", variant: "high" }] }) as never)).toThrow();
      appendRecord(review({ critics: [{ model: "anthropic/claude-opus-5", variant: "high" }] }) as never);
      expect(readRecords()).toHaveLength(1);
    });
    it("a MAXIMAL 3-round 3-critic review with max-length reasons still fits PIPE_BUF", () => {
      appendRecord(review({
        rounds: 3,
        critics: Array.from({ length: 3 }, () => ({ model: "anthropic/claude-opus-5", variant: "high" })),
        lens_status: ["schema", "falsifiable", "budget", "baseline", "precedent", "provenance"].map((lens) => ({
          lens, status: "skipped", reason: "y".repeat(200), // the schema cap
        })),
        findings_count: 27, blocking_count: 3,
        findings_ref: ".review/" + "z".repeat(120) + ".json",
      }) as never);
      expect(readRecords()).toHaveLength(1);
    });
  });

  describe("plan_compiled", () => {
    it("appends", () => {
      appendRecord({
        type: "plan_compiled", ts: ts(), plan_hash: "c".repeat(64), spec_id: "spec-1",
        design_hash: H, compiled_by: { model: "anthropic/claude-opus-5", variant: "high" },
        step_count: 3, advisory_count: 2, suggested_ttl_s: 7200, allow_unreviewed: false, source: "user",
      } as never);
      expect(row().step_count).toBe(3);
    });
    it("requires the design_hash binding — without it the gate cannot say `recompiled`", () => {
      expect(() =>
        appendRecord({ type: "plan_compiled", ts: ts(), plan_hash: "c", spec_id: "s", step_count: 1, source: "user" } as never),
      ).toThrow(/design_hash/);
    });
  });

  describe("todo", () => {
    it("waived REQUIRES a reason; fixed and obsolete do not", () => {
      expect(() =>
        appendRecord({ type: "todo", ts: ts(), plan_hash: "c", id: "A-1", state: "waived", source: "user" } as never),
      ).toThrow();
      appendRecord({ type: "todo", ts: ts(), plan_hash: "c", id: "A-1", state: "waived", reason: "out of scope", source: "user" } as never);
      appendRecord({ type: "todo", ts: ts(), plan_hash: "c", id: "A-2", state: "fixed", source: "user" } as never);
      appendRecord({ type: "todo", ts: ts(), plan_hash: "c", id: "A-3", state: "obsolete", source: "user" } as never);
      expect(readRecords()).toHaveLength(3);
    });
    it("rejects state:open — open is the ABSENCE of a row", () => {
      expect(() =>
        appendRecord({ type: "todo", ts: ts(), plan_hash: "c", id: "A-1", state: "open", source: "user" } as never),
      ).toThrow();
    });
    it("requires plan_hash, so advisory state is always scoped to a plan", () => {
      expect(() =>
        appendRecord({ type: "todo", ts: ts(), id: "A-1", state: "fixed", source: "user" } as never),
      ).toThrow(/plan_hash/);
    });
  });
});
