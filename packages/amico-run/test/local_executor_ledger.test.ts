// LocalExecutor.settle() emits the `solve` ledger stanza (Plan 3 / L1 Task 5).
// Structure/problem hashes + versions come from result.toml's [params] (the
// Julia runner's self-describing "regime the run actually solved"); the base
// summary (platform/template/trajectory/N/T/goal/solver/strategy) AND the
// recommendable knobs (Q/R/du_bound/max_iter/integrator — CRITICAL Task-4
// handoff, else ledger_query medians are permanently empty) come from the
// solvespec (the typed ProblemSpec run.toml's script_path points at). Any
// read/parse failure is logged + skipped — a ledger hiccup must never fail a run.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmpRoot, fakeJulia } from "./helpers.js";
import { LocalExecutor } from "../src/local_executor.js";
import { readRecords, type SolveRecord } from "../src/ledger.js";
import { solvesUnderPlan } from "../src/warrant_context.js";
import type { RunEvent, SpecStamp } from "../src/types.js";

async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
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

// Fake julia: writes result.toml into its cwd (= runDir, per LocalExecutor
// contract) before printing DONE — mirrors the real bundled solve env's
// write-temp-then-rename + result.toml shape, minus the atomic-rename step
// (irrelevant to this test — settle() only reads the final file).
const WRITE_RESULT = `
const fs = require('fs');
fs.writeFileSync('result.toml', [
  'schema_version = "1"',
  'fidelity = 0.9994',
  'iterations = 214',
  'wall_seconds = 38.2',
  '',
  '[params]',
  'structure_hash = "abc123structurehash"',
  'problem_hash = "def456problemhash"',
  'converged = true',
  '',
  '[params.versions]',
  'Piccolo = "1.19.0"',
].join('\\n'));
console.log('DONE fidelity=0.9994');
`;

describe("LocalExecutor.settle() emits the solve ledger stanza", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ledger-le-"));
    process.env.AMICO_LEDGER = join(dir, "runs.jsonl");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.AMICO_LEDGER;
  });

  it("appends exactly one solve record: hashes/versions from result.toml, summary+knobs from the solvespec", async () => {
    const root = tmpRoot();
    const julia = fakeJulia(root, "julia-solve", WRITE_RESULT);
    const spec: SpecStamp = { canonical: JSON.stringify(PROBLEM_SPEC), problem_spec: PROBLEM_SPEC };

    const h = await new LocalExecutor().submit(undefined, {
      runsRoot: join(root, "runs"),
      julia: { julia },
      spec,
    });
    await collect(h.events);
    await h.finished;

    const recs = readRecords().filter((r): r is SolveRecord => r.type === "solve");
    expect(recs).toHaveLength(1);
    const rec = recs[0];

    // hashes + versions + outcome ← result.toml
    expect(rec.structure_hash).toBe("abc123structurehash");
    expect(rec.problem_hash).toBe("def456problemhash");
    expect(rec.source).toBe("user");
    expect(rec.versions).toEqual({ Piccolo: "1.19.0" });
    expect(rec.outcome.fidelity).toBe(0.9994);
    expect(rec.outcome.iterations).toBe(214);
    expect(rec.outcome.wall_s).toBe(38.2);
    expect(rec.outcome.converged).toBe(true);

    // base summary ← the solvespec
    expect(rec.summary.platform).toBe("transmon");
    expect(rec.summary.template).toBe("SplinePulseProblem");
    expect(rec.summary.trajectory).toBe("unitary");
    expect(rec.summary.N).toBe(100);
    expect(rec.summary.T).toBe(100.0);
    expect(rec.summary.goal).toBe("CZ");
    expect(rec.summary.solver).toBe("ipopt");
    expect(rec.summary.strategy).toBe("direct");

    // CRITICAL (Task-4 handoff): recommendable knobs ← the solvespec's problem/solver
    // sections — ledger_query medians are permanently empty without these.
    expect(rec.summary.Q).toBe(100_000.0);
    expect(rec.summary.R).toBe(1e-4);
    expect(rec.summary.du_bound).toBe(50.0);
    expect(rec.summary.max_iter).toBe(300);
    expect(rec.summary.integrator).toBe("magnus_adapt4");
  });

  it("respects AMICO_LEDGER_SOURCE (so L-I replay can stamp source=replay)", async () => {
    process.env.AMICO_LEDGER_SOURCE = "replay";
    try {
      const root = tmpRoot();
      const julia = fakeJulia(root, "julia-solve", WRITE_RESULT);
      const spec: SpecStamp = { canonical: JSON.stringify(PROBLEM_SPEC), problem_spec: PROBLEM_SPEC };
      const h = await new LocalExecutor().submit(undefined, {
        runsRoot: join(root, "runs"),
        julia: { julia },
        spec,
      });
      await collect(h.events);
      await h.finished;
      const recs = readRecords().filter((r): r is SolveRecord => r.type === "solve");
      expect(recs).toHaveLength(1);
      expect(recs[0].source).toBe("replay");
    } finally {
      delete process.env.AMICO_LEDGER_SOURCE;
    }
  });

  it("never fails the run and never appends a record when result.toml is absent", async () => {
    const root = tmpRoot();
    const julia = fakeJulia(root, "julia-noop", `console.log('DONE fidelity=0')`);
    const script = fakeJulia(root, "s.jl", "");
    const h = await new LocalExecutor().submit(script, { runsRoot: join(root, "runs"), julia: { julia } });
    await collect(h.events);
    const fin = await h.finished;
    expect(fin.status).toBe("completed"); // the run itself is unaffected
    expect(readRecords()).toEqual([]);
  });

  // REGRESSION (found by adversarial spec review, 2026-07-28): the `max_solves`
  // warrant bound was structurally inert. warrant_context.solvesUnderPlan() counts
  // `solve` rows whose plan_hash matches, but SolveRecord had no plan_hash and the
  // schema's solve branch is additionalProperties:false — so a row carrying one
  // failed validation on append, and a row without one never matched. The counter
  // was permanently 0 and the bound never tripped. solvesUnderPlan's own unit test
  // passed throughout, because it builds its rows by hand: the seam was tested,
  // the wiring was not. This test drives the REAL emission path.
  it("stamps plan_hash from the solvespec, so the max_solves warrant bound can count", async () => {
    const root = tmpRoot();
    const julia = fakeJulia(root, "julia-solve", WRITE_RESULT);
    const planHash = "sha256:plan-under-warrant";
    const specWithPlan = { ...PROBLEM_SPEC, plan_hash: planHash };
    const spec: SpecStamp = { canonical: JSON.stringify(specWithPlan), problem_spec: specWithPlan };

    const h = await new LocalExecutor().submit(undefined, {
      runsRoot: join(root, "runs"),
      julia: { julia },
      spec,
    });
    await collect(h.events);
    await h.finished;

    const recs = readRecords().filter((r): r is SolveRecord => r.type === "solve");
    expect(recs).toHaveLength(1);
    expect(recs[0].plan_hash).toBe(planHash);
    // The join the bound actually depends on.
    expect(solvesUnderPlan(planHash, readRecords())).toBe(1);
    expect(solvesUnderPlan("sha256:some-other-plan", readRecords())).toBe(0);
  });

  it("omits plan_hash when the solvespec has none (ungated free-set launch)", async () => {
    const root = tmpRoot();
    const julia = fakeJulia(root, "julia-solve", WRITE_RESULT);
    const spec: SpecStamp = { canonical: JSON.stringify(PROBLEM_SPEC), problem_spec: PROBLEM_SPEC };
    const h = await new LocalExecutor().submit(undefined, {
      runsRoot: join(root, "runs"),
      julia: { julia },
      spec,
    });
    await collect(h.events);
    await h.finished;
    const recs = readRecords().filter((r): r is SolveRecord => r.type === "solve");
    expect(recs).toHaveLength(1);
    expect(recs[0].plan_hash).toBeUndefined();
  });

  it("skips (never throws) when result.toml lacks structure_hash/problem_hash", async () => {
    const root = tmpRoot();
    const julia = fakeJulia(
      root,
      "julia-partial",
      `const fs=require('fs'); fs.writeFileSync('result.toml','schema_version = "1"\\nfidelity = 0.5\\niterations = 1\\n'); console.log('DONE fidelity=0.5')`,
    );
    const script = fakeJulia(root, "s.jl", "");
    const h = await new LocalExecutor().submit(script, { runsRoot: join(root, "runs"), julia: { julia } });
    await collect(h.events);
    await h.finished;
    expect(readRecords()).toEqual([]);
  });
});
