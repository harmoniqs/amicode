// SEAM 5 (amicode #681) — the calibrate→pin→re-optimize→re-bank chain, executed
// END-TO-END on mock. Env-gated exactly like the SEAM 1 slow lane (Julia is NOT
// a vitest prerequisite — the fast suite runs without it):
//
//   AMICO_TEST_JULIA_PROJECT     the provisioned solve env (Piccolo ~1.19) —
//                                produces the real pulses via amico-run
//   AMICO_TEST_REHEARSAL_PROJECT the rehearsal env (templates/mocksoc-rehearsal/
//                                — Strumento 0.3 + Intonato 0.4 + Piccolo 2.1;
//                                instantiate once)
//   AMICO_TEST_JULIA_BIN         optional julia override (default: PATH's julia)
//
// The chain, leg by leg — every leg through its ESTABLISHED invocation:
//   1. solve A (the template, an under-converged cold start at max_iter=15 —
//      the bank's incumbent-to-be), via amico-run.
//   2. BANK A: `amico catalog ingest` into a temp catalog (the test STANDS IN
//      for the researcher's sign-off — promotions are human-gated like all
//      promotions; nothing here relaxes that).
//   3. CALIBRATE: the SEAM 1 MockSoc rehearsal runs banked pulse A through the
//      actual Strumento transport path — its "delta × 1.05" mismatch is the
//      calibration data → the pin δ=0.21 (the agent's derivation, recorded).
//   4. PIN + seed: recordCalibChain stages the chain (the calibration_pin
//      constraint lands on the formulation; the run stub carries the seed).
//   5. RE-OPTIMIZE: a warm-started re-solve (the load_traj idiom, seeded from
//      the BANK's copy of pulse A; the pinned δ=0.21 in the FILL IN block) via
//      amico-run — the existing solve path, no new tier.
//   6. RE-BANK: the EXACT command the chain staged, run through the real
//      `amico catalog ingest` (again the human-gate stand-in) — the promoted
//      entry's catalog note carries the fingerprint (which calibration, which
//      pin, which seed).
//   7. COMPLETE: completeCalibChain verifies the fingerprint and appends the
//      `executed_on_mock` event — `calib_pin_reopt_chain_executed_on_mock == 1`
//      is an EXECUTION RECORD (this run of this test is that record's proof).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

import { readRehearsalRecord } from "../../opencode-plugin/rehearsal";
import { formulationToml, type FormulationEntity } from "../../opencode-plugin/entities";
import { createProblem, problemDir, writeEntityFiles } from "../../opencode-plugin/problems";
import { recordCalibChain, completeCalibChain } from "../../opencode-plugin/calib_chain";

const SOLVE_PROJECT = process.env.AMICO_TEST_JULIA_PROJECT;
const REHEARSAL_PROJECT = process.env.AMICO_TEST_REHEARSAL_PROJECT;
const JULIA = process.env.AMICO_TEST_JULIA_BIN ?? "julia";
const AMICO_RUN_PKG = join(__dirname, "..", "..", "..", "amico-run");
const RUN_BIN = join(AMICO_RUN_PKG, "dist", "amico-run.js"); // β.1 bundle (solve launch)
const AMICO_BIN = join(AMICO_RUN_PKG, "dist", "amico.js"); // the verb router (catalog ingest)
const TEMPLATE = join(__dirname, "..", "..", "templates", "solve_template.jl");
const REHEARSAL_SCRIPT = join(__dirname, "..", "..", "templates", "mocksoc_rehearsal.jl");

/** Generate a solve script from the vetted template by editing ONLY the FILL IN
 *  block + the init lines — the sanctioned edit surfaces (no new physics, no
 *  new tier; the template is the vetted artifact). */
function solveScript(root: string, name: string, edits: [string, string][]): string {
  let src = readFileSync(TEMPLATE, "utf8");
  for (const [from, to] of edits) {
    if (!src.includes(from)) throw new Error(`template edit anchor missing: ${from}`);
    src = src.replace(from, to);
  }
  const p = join(root, name);
  writeFileSync(p, src);
  return p;
}

describe.skipIf(!(SOLVE_PROJECT && REHEARSAL_PROJECT))(
  "slow: the calibrate→pin→re-optimize chain on mock (SEAM 5 — executed end-to-end)",
  () => {
    const prevProblemsDir = process.env.AMICODE_PROBLEMS_DIR;
    let root: string;
    let slug: string;

    beforeAll(() => {
      execFileSync("node", [join(AMICO_RUN_PKG, "esbuild.config.mjs")], { cwd: AMICO_RUN_PKG });
    });

    afterAll(() => {
      if (prevProblemsDir === undefined) delete process.env.AMICODE_PROBLEMS_DIR;
      else process.env.AMICODE_PROBLEMS_DIR = prevProblemsDir;
      if (root && !process.env.AMICO_DEBUG_KEEP_DIR) rmSync(root, { recursive: true, force: true });
    });

    it(
      "calibrate (rehearsal) → pin → re-optimize (warm-started) → re-bank (provenanced) → executed_on_mock",
      { timeout: 1_800_000 },
      async () => {
        root = mkdtempSync(join(tmpdir(), "calib-chain-e2e-"));
        const problemsRoot = join(root, "problems");
        const catalogRoot = join(root, "catalog", "pulses");
        const runsRoot = join(root, "runs");
        process.env.AMICODE_PROBLEMS_DIR = problemsRoot;

        // ── leg 0 — solve A: the bank's incumbent-to-be (deliberately
        // under-converged cold start, so the warm-started re-solve can beat it).
        const scriptA = solveScript(root, "solve_A.jl", [["max_iter   = 60", "max_iter   = 15"]]);
        const outA = execFileSync(
          "node",
          [RUN_BIN, scriptA, "--runs-root", runsRoot, "--project", SOLVE_PROJECT!, "--lab", "devlab"],
          { encoding: "utf8", timeout: 900_000 },
        );
        expect(outA).toMatch(/AMICODE_FINISHED status=completed/);
        const runDirA = outA.match(/AMICODE_FINISHED .*runDir=(.+)/)![1].trim();
        const pulseA = join(runDirA, "pulse.jld2");
        const resultA = parse(readFileSync(join(runDirA, "result.toml"), "utf8")) as any;
        expect(existsSync(pulseA)).toBe(true);

        // ── BANK A — the day-one bank (the test stands in for the researcher's
        // sign-off; the human gate is the point, not an obstacle).
        const ingestEnv = { ...process.env, AMICO_CATALOG_DIR: catalogRoot };
        const bankA = execFileSync(
          "node",
          [AMICO_BIN, "catalog", "ingest", "--platform", "transmon", "--kind", "X", "--from-run", runDirA, "--agree", "true"],
          { encoding: "utf8", env: ingestEnv, timeout: 60_000 },
        );
        expect(JSON.parse(bankA).promoted).toBe(true);
        const seedId = JSON.parse(bankA).id; // transmon-X-v1

        // ── leg 1 — CALIBRATE: the SEAM 1 rehearsal is the calibration data source.
        const rehearsalDir = join(root, "rehearsal");
        const rehOut = execFileSync(
          JULIA,
          ["--startup-file=no", `--project=${REHEARSAL_PROJECT}`, REHEARSAL_SCRIPT, pulseA, join(runDirA, "result.toml"), rehearsalDir],
          { encoding: "utf8", timeout: 900_000 },
        );
        expect(rehOut).toMatch(/REHEARSAL outcome=success/);
        const rehearsalArtifact = join(rehearsalDir, "rehearsal.toml");
        const rr = readRehearsalRecord(rehearsalArtifact);
        expect(rr.ok).toBe(true);
        if (!rr.ok) throw new Error(rr.problem);
        expect(rr.record.mismatch).toMatch(/delta × 1\.05/); // the mock truth — the calibration's evidence

        // ── leg 2+3 — PIN + seed: stage the chain (the recording path).
        slug = createProblem("calib-chain-e2e").slug;
        const dir = problemDir(slug);
        const sys = {
          platform: "transmon",
          components: [{ id: "q1", role: "qubit", levels: 3, params: { omega: 4.8, delta: 0.2 } }],
          couplings: [],
          drive: { arch: "per-component" },
        };
        writeEntityFiles(slug, "system", "x\n", JSON.stringify(sys) + "\n");
        const form: FormulationEntity = {
          trajectory_type: "gate",
          time_mode: "fixed",
          parameterization: "smooth",
          robustness: { kind: "none", params: {} },
          free_phase: false,
          leakage: false,
          target: "X",
          objectives: [],
          constraints: [{ kind: "bounds", params: {}, label: "amplitude bound (drive_max)" }],
        };
        writeEntityFiles(slug, "formulation", formulationToml(form), JSON.stringify(form) + "\n");

        const stage1 = recordCalibChain({
          slug,
          leg: "mock",
          rehearsalRef: rehearsalArtifact,
          pinned: { delta: 0.21 }, // 0.2 nominal × the rehearsal's declared 1.05 mismatch
          warmStart: seedId,
        });
        expect(stage1.ok).toBe(true);
        if (!stage1.ok) throw new Error(stage1.problem);

        // ── leg 3 — RE-OPTIMIZE: the warm-started re-solve (the load_traj idiom,
        // seeded from the BANK's copy of pulse A; the pin made real: δ=0.21).
        const bankedSeed = join(catalogRoot, seedId, "pulse.jld2");
        expect(existsSync(bankedSeed)).toBe(true);
        const scriptB = solveScript(root, "solve_B.jl", [
          ["δ          = 0.2", "δ          = 0.21"],
          [
            "initial = 0.1 * randn(sys.n_drives, N)\nqtraj = UnitaryTrajectory(sys, ZeroOrderPulse(initial, times), op)",
            `warm = load_traj("${bankedSeed}")  # the banked pulse, re-wrapped for THIS problem:
qtraj = UnitaryTrajectory(sys, ZeroOrderPulse(warm), op)`,
          ],
        ]);
        const outB = execFileSync(
          "node",
          [RUN_BIN, scriptB, "--runs-root", runsRoot, "--project", SOLVE_PROJECT!, "--lab", "devlab"],
          { encoding: "utf8", timeout: 900_000 },
        );
        expect(outB).toMatch(/AMICODE_FINISHED status=completed/);
        const runDirB = outB.match(/AMICODE_FINISHED .*runDir=(.+)/)![1].trim();
        const resultB = parse(readFileSync(join(runDirB, "result.toml"), "utf8")) as any;
        expect(resultB.fidelity).toBeGreaterThan(resultA.fidelity); // the warm-started re-solve improved on the bank

        // re-stage with the re-solve's run dir — the chain's staged re-bank command goes concrete.
        const stage2 = recordCalibChain({
          slug,
          leg: "mock",
          rehearsalRef: rehearsalArtifact,
          pinned: { delta: 0.21 },
          warmStart: seedId,
          runDir: runDirB,
        });
        expect(stage2.ok).toBe(true);
        if (!stage2.ok) throw new Error(stage2.problem);
        expect(stage2.staged.rebankCommand).toContain(`--from-run ${runDirB}`);
        expect(stage2.staged.rebankCommand).toContain(`--calibration-ref ${rehearsalArtifact}`);
        expect(stage2.staged.rebankCommand).toContain("--pin delta=0.21");
        expect(stage2.staged.rebankCommand).toContain(`--warm-start ${seedId}`);

        // ── leg 4 — RE-BANK: the EXACT staged command, run through the real
        // catalog ingest (the human-gate stand-in again). The promoted entry's
        // note must carry the chain's fingerprint.
        const stagedArgs = stage2.staged.rebankCommand.split(/\s+/).slice(3); // "amico catalog ingest …" → args after the verb
        const bankB = execFileSync(
          "node",
          [AMICO_BIN, "catalog", "ingest", ...stagedArgs, "--agree", "true"],
          { encoding: "utf8", env: ingestEnv, timeout: 60_000 },
        );
        const banked = JSON.parse(bankB);
        expect(banked.promoted).toBe(true); // beats the incumbent — the Version rule
        const rebankId = banked.id; // transmon-X-v2
        const metaFile = join(catalogRoot, rebankId, "metadata.toml");
        const meta = parse(readFileSync(metaFile, "utf8")) as any;
        expect(meta.warm_start).toBe(seedId); // which seed
        expect(meta.calibration_ref).toBe(rehearsalArtifact); // which calibration
        expect(meta.pinned_globals).toEqual({ delta: 0.21 }); // which pin

        // ── COMPLETE: verify the fingerprint, land the execution record.
        const done = completeCalibChain({ slug, rebankMetadataRef: metaFile });
        expect(done.ok).toBe(true);
        if (!done.ok) throw new Error(done.problem);
        expect(done.executed_on_mock).toBe(true);

        // ── the assertions — entities + events express the chain, and the
        // execution record is COUNTABLE (== 1, not a schema).
        const events = readFileSync(join(dir, "events.jsonl"), "utf8")
          .split("\n")
          .filter((l) => l.trim() !== "")
          .map((l) => JSON.parse(l));
        const executed = events.filter((e) => e.entity === "calib_chain" && e.action === "executed_on_mock");
        expect(executed).toHaveLength(1); // calib_pin_reopt_chain_executed_on_mock == 1
        const kinds = events.map((e) => `${e.entity}:${e.action}`);
        expect(kinds).toContain("formulation:updated"); // the pin (existing entity)
        expect(kinds).toContain("run:updated"); // the warm-start seed (existing entity)
        expect(kinds).toContain("calib_chain:updated");

        const formAfter = parse(readFileSync(join(dir, "entities", "formulation.toml"), "utf8")) as any;
        const pin = formAfter.formulation.constraints.find((c: any) => c.kind === "calibration_pin");
        expect(pin.params.delta).toBeCloseTo(0.21);
        expect(formAfter.formulation.solve.pinned_globals).toEqual(["delta"]);

        const runAfter = parse(readFileSync(join(dir, "entities", "run.toml"), "utf8")) as any;
        expect(runAfter.run.warm_start).toBe(seedId);
        expect(runAfter.run.run_dir).toBe(runDirB);

        const chain = parse(readFileSync(join(dir, "entities", "calib_chain.toml"), "utf8")) as any;
        expect(chain.calib_chain.promotion).toBe("human-gated-rebank-recorded");
        expect(chain.calib_chain.rebank.catalog_entry).toBe(rebankId);
        expect(chain.calib_chain.rebank.provenance.pinned_globals.delta).toBeCloseTo(0.21);
        expect(chain.calib_chain.calibration.source).toBe(rehearsalArtifact);
      },
    );
  },
);
