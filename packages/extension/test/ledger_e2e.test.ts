// L1 end-to-end acceptance (Plan 3 Task 9): two solves of the SAME structure
// (same structure_hash, DISTINCT problem_hash — review correction #3) go
// through the REAL amico-run LocalExecutor → REAL solve ledger stanzas
// (Task 5), one gets an `agree` verdict (Task 7's verdictStanza + appendStanza,
// shelling the REAL built CLI), and the extension's ledger_client.ts
// (queryLedger + selectRecommendations — the logic behind
// `amicode_recommend action:"query"`) returns honest "n=2 runs, 1 verified"
// provenance with confidence capped at medium (spec success criteria 1 + 5).
//
// This is a cross-package integration test (amico-run's LocalExecutor +
// the extension's ledger_client.ts), which is why it lives here rather than in
// either package alone: @amicode/amico-run is a real dependency of `amicode`
// (unlike opencode-plugin's Bun-runtime restriction — this is a normal vitest
// test file, ordinary package resolution applies).
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutor, defaultRunsRoot, type RunEvent, type SpecStamp } from "@amicode/amico-run";
import { appendRunRef, problemDir } from "../opencode-plugin/problems";
import {
  queryLedger,
  selectRecommendations,
  resolveWorkspaceSpecContext,
  verdictStanza,
  appendStanza,
} from "../opencode-plugin/ledger_client";

const AMICO_RUN_PKG_DIR = join(__dirname, "..", "..", "amico-run");

async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

function fakeJulia(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

const PROBLEM_SPEC = {
  schema_version: 1,
  kind: "control",
  system: { kind: "template", template: "TransmonSystem" },
  goal: { kind: "unitary", gate: "CZ" },
  pulse: { kind: "cubic_spline", T: 100.0 },
  problem: { template: "SplinePulseProblem", N: 100, Q: 100_000.0, R: 1e-4, du_bound: 50.0 },
  solver: { backend: "ipopt", strategy: "direct", max_iter: 300 },
  integrator: { kind: "spline", alg: "magnus_adapt4" },
};

const STRUCTURE_HASH = "sh-e2e-cz-transmon";

/** Fake julia: writes result.toml with a FIXED structure_hash but a caller-given
 *  problem_hash (real runs would derive both from the ProblemSpec; Task 5 just
 *  forwards whatever the runner reports, so this is a faithful stand-in). */
function writeResultScript(problemHash: string): string {
  const toml = [
    'schema_version = "1"',
    "fidelity = 0.999",
    "iterations = 50",
    "",
    "[params]",
    `structure_hash = "${STRUCTURE_HASH}"`,
    `problem_hash = "${problemHash}"`,
    "converged = true",
  ].join("\n");
  return `const fs = require('fs'); fs.writeFileSync('result.toml', ${JSON.stringify(toml)}); console.log('DONE fidelity=0.999');`;
}

describe("L1 end-to-end: two solves of one structure → ledger-backed query with honest provenance", () => {
  let root: string;
  let ledgerDir: string;
  let problemsRoot: string;
  const prevProblems = process.env.AMICODE_PROBLEMS_DIR;

  beforeAll(() => {
    // Ensure the REAL CLI bundle exists (queryLedger/appendStanza shell it) —
    // mirrors amico-run's own ledger_verb.test.ts bundle beforeAll.
    execFileSync("node", [join(AMICO_RUN_PKG_DIR, "esbuild.config.mjs")], { cwd: AMICO_RUN_PKG_DIR });
  }, 60_000);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ledger-e2e-"));
    ledgerDir = mkdtempSync(join(tmpdir(), "ledger-e2e-ledger-"));
    problemsRoot = mkdtempSync(join(tmpdir(), "ledger-e2e-problems-"));
    process.env.AMICO_LEDGER = join(ledgerDir, "runs.jsonl");
    process.env.AMICODE_PROBLEMS_DIR = problemsRoot;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
    rmSync(problemsRoot, { recursive: true, force: true });
    delete process.env.AMICO_LEDGER;
    if (prevProblems === undefined) delete process.env.AMICODE_PROBLEMS_DIR;
    else process.env.AMICODE_PROBLEMS_DIR = prevProblems;
  });

  it('two runs (distinct problem_hash, one verified) → "n=2 runs, 1 verified" provenance, confidence capped at medium', async () => {
    const lab = "default";
    const runsRoot = defaultRunsRoot(lab);
    const slug = "cz-transmon-e2e";

    // ── run 1 (ph-A) ──
    const julia1 = fakeJulia(root, "julia-1", writeResultScript("ph-A"));
    const spec1: SpecStamp = { canonical: JSON.stringify(PROBLEM_SPEC), problem_spec: PROBLEM_SPEC };
    const h1 = await new LocalExecutor().submit(undefined, { lab, runsRoot, julia: { julia: julia1 }, spec: spec1 });
    await collect(h1.events);
    await h1.finished;
    appendRunRef(slug, { run_id: h1.runId, lab, recorded: new Date().toISOString() });

    // ── run 2 (ph-B) — same structure, distinct problem instance ──
    const julia2 = fakeJulia(root, "julia-2", writeResultScript("ph-B"));
    const spec2: SpecStamp = { canonical: JSON.stringify(PROBLEM_SPEC), problem_spec: PROBLEM_SPEC };
    const h2 = await new LocalExecutor().submit(undefined, { lab, runsRoot, julia: { julia: julia2 }, spec: spec2 });
    await collect(h2.events);
    await h2.finished;
    appendRunRef(slug, { run_id: h2.runId, lab, recorded: new Date().toISOString() });

    expect(h1.runId).not.toBe(h2.runId);

    // ── exactly one `agree` verdict, for ph-A only ──
    expect(
      appendStanza(verdictStanza({ problemHash: "ph-A", structureHash: STRUCTURE_HASH, verdict: "agree" })),
    ).toBe(true);

    // ── resolve the workspace's structure_hash/N/T from its most recent run ──
    const ctx = resolveWorkspaceSpecContext(slug);
    expect(ctx?.structure_hash).toBe(STRUCTURE_HASH);
    expect(ctx?.N).toBe(100);
    expect(ctx?.T).toBe(100);

    // ── the real query, through the real built CLI ──
    const result = queryLedger(ctx!.structure_hash, ctx!.N!, ctx!.T!);
    expect(result).toBeDefined();
    expect(result?.total).toBe(2);
    expect(result?.verified).toBe(1);
    expect(result?.provenance).toMatch(/n=2 runs, 1 verified/);
    expect(result?.confidence).toBe("medium"); // small n, not yet high-eligible

    // ── the amicode_recommend action="query" logic: never exceeds medium ──
    const recs = selectRecommendations(result!, ["Q"]);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ param: "Q", value: 100_000, provenance: result!.provenance });
    expect(recs[0].confidence).not.toBe("high");
    expect(recs[0].confidence).toBe("medium");
  }, 30_000);
});
