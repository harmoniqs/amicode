// `amico ledger` spine verb (Plan 3 / L1 Task 3) — append + query. The verb body
// is exercised in-process (fast) for append/query/error paths; the bundle
// (dist/amico.js) proves CLI registration and — critically — real cross-process
// O_APPEND atomicity by spawning concurrent `amico ledger append` subprocesses.
// Run: pnpm --filter @amicode/amico-run test ledger_verb
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledgerVerb } from "../src/ledger_verb.js";
import { readRecords, type SolveRecord } from "../src/ledger.js";

const solveRec = (over: Partial<SolveRecord> = {}): SolveRecord => ({
  type: "solve",
  ts: "2026-07-22T00:00:00Z",
  structure_hash: "abc",
  problem_hash: "def",
  kind: "control",
  tier: "spec",
  summary: { platform: "transmon", template: "SplinePulseProblem", trajectory: "unitary", N: 100, T: 100.0, goal: "CZ", solver: "ipopt", strategy: "direct", Q: 100_000 },
  source: "user",
  outcome: { converged: true, fidelity: 0.9994, iterations: 214, wall_s: 38.2 },
  versions: { Piccolo: "0.9.2" },
  ...over,
});

// ── in-process verb body ─────────────────────────────────────────────────────
describe("ledgerVerb (in-process)", () => {
  let dir: string;
  const prev = process.env.AMICO_LEDGER;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ledger-verb-"));
    process.env.AMICO_LEDGER = join(dir, "runs.jsonl");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.AMICO_LEDGER;
    else process.env.AMICO_LEDGER = prev;
  });

  it("append --json <stanza> validates and writes the record", () => {
    const r = ledgerVerb(["append", "--json", JSON.stringify(solveRec())]) as { json: Record<string, unknown>; code: number };
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ verb: "ledger", subcommand: "append", ok: true, type: "solve" });
    const recs = readRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0].type).toBe("solve");
  });

  it("append rejects malformed JSON with a structured error + nonzero code", () => {
    const r = ledgerVerb(["append", "--json", "{not json"]) as { json: Record<string, unknown>; code: number };
    expect(r.code).not.toBe(0);
    expect(String(r.json.error)).toMatch(/json|parse/i);
    expect(readRecords()).toEqual([]);
  });

  it("append rejects a schema-invalid record (honest ledger) with nonzero code", () => {
    const bad = solveRec() as unknown as Record<string, unknown>;
    delete bad.structure_hash;
    const r = ledgerVerb(["append", "--json", JSON.stringify(bad)]) as { json: Record<string, unknown>; code: number };
    expect(r.code).not.toBe(0);
    expect(String(r.json.error)).toMatch(/invalid ledger record/i);
    expect(readRecords()).toEqual([]);
  });

  it("query returns params / provenance / confidence for a structure key", () => {
    ledgerVerb(["append", "--json", JSON.stringify(solveRec({ problem_hash: "ph-A", summary: { ...solveRec().summary, Q: 100_000 } }))]);
    ledgerVerb(["append", "--json", JSON.stringify(solveRec({ problem_hash: "ph-B", summary: { ...solveRec().summary, Q: 200_000 } }))]);
    const r = ledgerVerb(["query", "--structure-hash", "abc", "--n", "100", "--t", "100"]) as { json: Record<string, unknown>; code: number };
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ verb: "ledger", subcommand: "query" });
    expect(r.json).toHaveProperty("params");
    expect(r.json).toHaveProperty("provenance");
    expect(r.json).toHaveProperty("confidence");
    expect((r.json.params as Record<string, { value: number }>).Q.value).toBe(150_000);
  });

  it("query without the required key flags → usage error (64)", () => {
    const r = ledgerVerb(["query", "--n", "100"]) as { code: number };
    expect(r.code).toBe(64);
  });

  it("an unknown subcommand → usage error (64)", () => {
    expect((ledgerVerb(["frobnicate"]) as { code: number }).code).toBe(64);
  });
});

// ── bundle: registration + cross-process atomicity ───────────────────────────
const BUNDLE = join(__dirname, "..", "dist", "amico.js");
beforeAll(() => {
  execFileSync("node", [join(__dirname, "..", "esbuild.config.mjs")], { cwd: join(__dirname, "..") });
});
function run(args: string[], env: Record<string, string> = {}, input?: string): { code: number; stdout: string } {
  try {
    const stdout = execFileSync("node", [BUNDLE, ...args], { encoding: "utf8", env: { ...process.env, ...env }, input });
    return { code: 0, stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? "" };
  }
}

describe("amico ledger (bundle)", () => {
  let ledger: string;
  beforeEach(() => {
    ledger = join(mkdtempSync(join(tmpdir(), "ledger-cli-")), "runs.jsonl");
  });
  afterEach(() => rmSync(join(ledger, ".."), { recursive: true, force: true }));

  it("is registered in the amico verb surface (--help lists ledger)", () => {
    const r = run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/ledger/);
  });

  it("append (via stdin) then query works end-to-end through the CLI", () => {
    const rec = solveRec({ problem_hash: "ph-1", summary: { ...solveRec().summary, Q: 120_000 } });
    const a = run(["ledger", "append"], { AMICO_LEDGER: ledger }, JSON.stringify(rec));
    expect(a.code).toBe(0);
    expect(JSON.parse(a.stdout)).toMatchObject({ ok: true, type: "solve" });
    const q = run(["ledger", "query", "--structure-hash", "abc", "--n", "100", "--t", "100"], { AMICO_LEDGER: ledger });
    expect(q.code).toBe(0);
    const out = JSON.parse(q.stdout);
    expect(out.total).toBe(1);
    expect(out.provenance).toMatch(/n=1 runs, 0 verified/);
  });

  it("append --json malformed stanza → nonzero exit through the CLI", () => {
    const a = run(["ledger", "append", "--json", "{broken"], { AMICO_LEDGER: ledger });
    expect(a.code).not.toBe(0);
  });

  // The load-bearing single-writer guarantee: MULTIPLE amico-run processes append
  // concurrently and every line must survive intact (O_APPEND atomicity ≤ PIPE_BUF).
  it("is append-safe under real concurrent subprocess writers (no interleaving)", async () => {
    const N = 24;
    const spawnAppend = (i: number): Promise<number> =>
      new Promise((resolve) => {
        const rec = { type: "attempt_error", ts: "t", session: `s${i}`, errors: [] };
        const child = spawn("node", [BUNDLE, "ledger", "append", "--json", JSON.stringify(rec)], {
          env: { ...process.env, AMICO_LEDGER: ledger },
          stdio: "ignore",
        });
        child.on("close", (code) => resolve(code ?? -1));
      });
    const codes = await Promise.all(Array.from({ length: N }, (_, i) => spawnAppend(i)));
    expect(codes.every((c) => c === 0)).toBe(true);
    const lines = readFileSync(ledger, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(N);
    // every line is intact, valid JSON, with the expected shape → no interleaving
    const sessions = lines.map((l) => JSON.parse(l).session).sort();
    expect(sessions).toEqual(Array.from({ length: N }, (_, i) => `s${i}`).sort());
  });
});
