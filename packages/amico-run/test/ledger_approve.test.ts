// `amico ledger approve` (spec-20260727-164748 §5, plan task CLI-3) — mints a
// capability warrant. This is the transport the approval card requires (spec §9.5):
// an approval must reach the ledger DIRECTLY, never via the agent's reading of a
// user turn, or the provenance reads "the agent says the user approved".
//
// It deliberately reuses appendRecord rather than adding a second writer — #212's
// single-writer rule for the ledger is load-bearing for atomicity.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledgerVerb } from "../src/ledger_verb.js";
import { readRecords, ledgerPath, type ApprovalRecord } from "../src/ledger.js";

type Result = { json: Record<string, unknown>; code: number };

describe("ledger approve", () => {
  let dir: string;
  const prev = process.env.AMICO_LEDGER;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ledger-approve-"));
    process.env.AMICO_LEDGER = join(dir, "runs.jsonl");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.AMICO_LEDGER;
    else process.env.AMICO_LEDGER = prev;
  });

  it("mints a schema-valid warrant with the declared bounds", () => {
    const r = ledgerVerb([
      "approve",
      "--plan-hash", "9f2c",
      "--max-solves", "8",
      "--tier", "free",
      "--expires-in", "3600",
      "--issued-by", "user:cli",
    ]) as Result;
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ verb: "ledger", subcommand: "approve", ok: true, plan_hash: "9f2c" });

    const recs = readRecords();
    expect(recs).toHaveLength(1);
    const rec = recs[0] as ApprovalRecord;
    expect(rec.type).toBe("approval");
    expect(rec.plan_hash).toBe("9f2c");
    expect(rec.bounds).toEqual({ max_solves: 8, tier: "free" });
    expect(rec.issued_by).toBe("user:cli");
    expect(Date.parse(rec.expires_at)).toBeGreaterThan(Date.parse(rec.ts));
  });

  it("--plan-hash is required, and nothing is written without it", () => {
    const r = ledgerVerb(["approve", "--max-solves", "8"]) as Result;
    expect(r.code).toBe(64);
    expect(String(r.json.error)).toContain("--plan-hash");
    expect(existsSync(ledgerPath())).toBe(false);
  });

  it("omitted bounds are ABSENT, never defaulted — absence must not read as unlimited", () => {
    // Spec §5.1 rule 2: the gate refuses a launch needing a bound the warrant
    // omits. A verb that helpfully filled in a default would silently widen it.
    const r = ledgerVerb(["approve", "--plan-hash", "9f2c"]) as Result;
    expect(r.code).toBe(0);
    const rec = readRecords()[0] as ApprovalRecord;
    expect(rec.bounds).toEqual({});
  });

  it("device bounds accept the §2.1 vocabulary and reject anything else", () => {
    expect((ledgerVerb(["approve", "--plan-hash", "h", "--device", "ro"]) as Result).code).toBe(0);
    expect((readRecords()[0] as ApprovalRecord).bounds.device).toBe("ro");
    expect((ledgerVerb(["approve", "--plan-hash", "h", "--device", "yes"]) as Result).code).toBe(64);
  });

  it("rejects a non-numeric or non-positive --max-solves rather than writing a bad row", () => {
    for (const bad of ["zero", "0", "-1", "1.5"]) {
      const r = ledgerVerb(["approve", "--plan-hash", "h", "--max-solves", bad]) as Result;
      expect(r.code, `--max-solves ${bad}`).toBe(64);
    }
    expect(existsSync(ledgerPath())).toBe(false);
  });

  it("rejects a non-positive --expires-in", () => {
    expect((ledgerVerb(["approve", "--plan-hash", "h", "--expires-in", "0"]) as Result).code).toBe(64);
    expect((ledgerVerb(["approve", "--plan-hash", "h", "--expires-in", "nope"]) as Result).code).toBe(64);
  });

  it("issued_by defaults to a named local actor rather than empty provenance", () => {
    const r = ledgerVerb(["approve", "--plan-hash", "9f2c"]) as Result;
    expect(r.code).toBe(0);
    expect((readRecords()[0] as ApprovalRecord).issued_by).toBeTruthy();
  });

  it("the unknown-subcommand usage line mentions approve", () => {
    const r = ledgerVerb(["nonesuch"]) as Result;
    expect(String(r.json.usage)).toContain("approve");
  });
});
