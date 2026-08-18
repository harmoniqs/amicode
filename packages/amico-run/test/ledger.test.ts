// Ledger core (Plan 3 / L1 Task 1) — the append-only single-writer JSONL substrate.
// Pure I/O against a temp ledger pointed to by $AMICO_LEDGER. Run:
//   pnpm --filter @amicode/amico-run test ledger
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRecord, readRecords, ledgerPath, PIPE_BUF, gpuTotals, type SolveRecord, type LedgerRecord } from "../src/ledger.js";

let dir: string;
const prevEnv = process.env.AMICO_LEDGER;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-"));
  process.env.AMICO_LEDGER = join(dir, "runs.jsonl");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prevEnv === undefined) delete process.env.AMICO_LEDGER;
  else process.env.AMICO_LEDGER = prevEnv;
});


function writeTmpLedger(rows: LedgerRecord[]): string {
  for (const r of rows) appendRecord(r);
  return ledgerPath();
}

const solve = (over: Partial<SolveRecord> = {}): SolveRecord => ({
  type: "solve",
  ts: "2026-07-22T00:00:00Z",
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
  source: "user",
  outcome: { converged: true, fidelity: 0.9994, iterations: 214, wall_s: 38.2 },
  versions: { Piccolo: "1.19.0" },
  ...over,
});

describe("ledger core", () => {
  it("ledgerPath honors $AMICO_LEDGER", () => {
    expect(ledgerPath()).toBe(join(dir, "runs.jsonl"));
  });

  it("appends and reads back records in order", () => {
    appendRecord(solve());
    const recs = readRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0].type).toBe("solve");
    expect((recs[0] as SolveRecord).outcome.fidelity).toBe(0.9994);
  });

  it("readRecords returns [] when the ledger does not exist yet", () => {
    expect(readRecords()).toEqual([]);
  });

  it("preserves insertion order across many appends", () => {
    for (let i = 0; i < 20; i++) {
      appendRecord({ type: "attempt_error", ts: "t", session: `s${i}`, errors: [] });
    }
    const recs = readRecords();
    expect(recs).toHaveLength(20);
    expect(recs.every((r) => r.type === "attempt_error")).toBe(true);
    expect(recs.map((r) => (r as { session: string }).session)).toEqual(
      Array.from({ length: 20 }, (_, i) => `s${i}`),
    );
  });

  // The single-writer atomicity contract: O_APPEND writes are atomic on Linux only
  // up to PIPE_BUF (4096 B). appendRecord asserts the serialized line stays under
  // that ceiling so a large solve record can never silently interleave.
  it("rejects a record whose serialized line exceeds PIPE_BUF", () => {
    const versions: Record<string, string> = {};
    for (let i = 0; i < 500; i++) versions[`Package${i}`] = "1.0.0";
    expect(() => appendRecord(solve({ versions }))).toThrow(/PIPE_BUF/);
    // and nothing was written — the ledger stays honest
    expect(readRecords()).toEqual([]);
  });

  it("accepts a realistic solve record comfortably under the ceiling", () => {
    appendRecord(solve());
    const line = readFileSync(ledgerPath(), "utf8").split("\n").filter(Boolean)[0];
    expect(Buffer.byteLength(line + "\n", "utf8")).toBeLessThan(PIPE_BUF);
  });
});

// ── ledger gpu (#425): sum the receipt rows — the warrant fold's view ──────
describe("ledger gpu totals (receipt rows, #425)", () => {
  it("sums gpu_seconds/cost across receipt rows, breaks down by SKU, counts by status", () => {
    const f = writeTmpLedger([
      { type: "receipt", ts: "2026-08-18T10:00:00Z", task_id: "a", executor: "remote", gpu_sku: "H100-80GB", gpu_seconds: 900, cost_usd: 2.7, status: "completed" },
      { type: "receipt", ts: "2026-08-18T11:00:00Z", task_id: "b", executor: "remote", gpu_sku: "H100-80GB", gpu_seconds: 300, cost_usd: 0.9, status: "failed" },
      { type: "receipt", ts: "2026-08-18T12:00:00Z", task_id: "c", executor: "remote", gpu_sku: "A100-40GB", gpu_seconds: 600 },
      { type: "solve", ts: "2026-08-18T13:00:00Z", structure_hash: "x", problem_hash: "y", kind: "control", tier: "hpc", summary: { platform: "p", template: "t", trajectory: "g", N: 10, T: 10, goal: "g", solver: "s", strategy: "s" }, source: "user", outcome: { converged: true, fidelity: 0.99, iterations: 5 } },
    ]);
    const t = gpuTotals(f);
    expect(t.receipts).toBe(3);
    expect(t.gpu_seconds).toBe(1800);
    expect(t.cost_usd).toBeCloseTo(3.6);
    expect(t.by_sku).toEqual({ "H100-80GB": { gpu_seconds: 1200, cost_usd: 3.6 }, "A100-40GB": { gpu_seconds: 600 } });
    expect(t.by_status).toEqual({ completed: 1, failed: 1 });
  });
  it("an empty or receipt-less ledger is zeros, never a throw", () => {
    const t = gpuTotals(writeTmpLedger([]));
    expect(t).toEqual({ receipts: 0, gpu_seconds: 0, cost_usd: 0, by_sku: {}, by_status: {} });
  });
});
