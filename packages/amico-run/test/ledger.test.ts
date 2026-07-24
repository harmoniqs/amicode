// Ledger core (Plan 3 / L1 Task 1) — the append-only single-writer JSONL substrate.
// Pure I/O against a temp ledger pointed to by $AMICO_LEDGER. Run:
//   pnpm --filter @amicode/amico-run test ledger
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRecord, readRecords, ledgerPath, PIPE_BUF, type SolveRecord } from "../src/ledger.js";

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
