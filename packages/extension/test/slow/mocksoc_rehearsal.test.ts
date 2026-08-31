// SEAM 1 (amicode #680) — the end-to-end MockSoc rehearsal, env-gated.
//
// Julia is NOT a vitest prerequisite (the fast suite must run without it):
// this file skips VISIBLY unless both envs are provided, the same gating
// idiom as template.test.ts / verify_harness.test.ts:
//
//   AMICO_TEST_JULIA_PROJECT     the provisioned solve env (Piccolo ~1.19) —
//                                produces the real solved pulse via amico-run,
//                                exactly the template.test.ts lane
//   AMICO_TEST_REHEARSAL_PROJECT the rehearsal env (templates/mocksoc-rehearsal/
//                                — Strumento 0.3 + Intonato 0.4 + Piccolo 2.x
//                                from the General registry; instantiate once)
//   AMICO_TEST_JULIA_BIN         optional julia override (default: PATH's julia)
//
// The rehearsal consumes the REAL run-dir artifacts (pulse.jld2 + result.toml
// from an actual template solve) and must pass through the ACTUAL Strumento
// MockSoc transport path — no Python, no board, no bespoke sim.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { readRehearsalRecord } from "../../opencode-plugin/rehearsal";
import { rehearsalSatisfiesStage } from "../../opencode-plugin/entities";

const SOLVE_PROJECT = process.env.AMICO_TEST_JULIA_PROJECT;
const REHEARSAL_PROJECT = process.env.AMICO_TEST_REHEARSAL_PROJECT;
const JULIA = process.env.AMICO_TEST_JULIA_BIN ?? "julia";
const RUN = join(__dirname, "..", "..", "..", "amico-run", "dist", "amico-run.js"); // β.1 bundle
const TEMPLATE = join(__dirname, "..", "..", "templates", "solve_template.jl");
const REHEARSAL_SCRIPT = join(__dirname, "..", "..", "templates", "mocksoc_rehearsal.jl");

describe.skipIf(!(SOLVE_PROJECT && REHEARSAL_PROJECT))(
  "slow: MockSoc rehearsal E2E (SEAM 1 — the real transport path)",
  () => {
    it(
      "a real template solve's pulse passes the rehearsal and satisfies the stage gate",
      () => {
        const root = mkdtempSync(join(tmpdir(), "rehearsal-e2e-"));
        // 1. Real solve — the run-dir contract (pulse.jld2 + result.toml).
        const stdout = execFileSync(
          "node",
          [RUN, TEMPLATE, "--runs-root", join(root, "runs"), "--project", SOLVE_PROJECT!, "--lab", "devlab"],
          { encoding: "utf8", timeout: 600_000 },
        );
        expect(stdout).toMatch(/AMICODE_FINISHED status=completed/);
        const runDir = stdout.match(/AMICODE_FINISHED .*runDir=(.+)/)![1].trim();
        const pulse = join(runDir, "pulse.jld2");
        const result = join(runDir, "result.toml");
        expect(existsSync(pulse)).toBe(true);
        expect(existsSync(result)).toBe(true);

        // 2. The rehearsal — the established Julia-launch idiom: julia
        //    --startup-file=no --project=<env> <script> <args>, stdout carries
        //    the verdict line.
        const outDir = join(root, "rehearsal");
        const rehOut = execFileSync(
          JULIA,
          ["--startup-file=no", `--project=${REHEARSAL_PROJECT}`, REHEARSAL_SCRIPT, pulse, result, outDir],
          { encoding: "utf8", timeout: 900_000 },
        );
        expect(rehOut).toMatch(/REHEARSAL outcome=success/);

        // 3. The artifact — read through the SAME reader the tool uses, and
        //    gate on it: outcome success + the pulse content-hash binds the
        //    record to the exact artifact rehearsed.
        const artifact = join(outDir, "rehearsal.toml");
        expect(existsSync(artifact)).toBe(true);
        const rr = readRehearsalRecord(artifact);
        expect(rr.ok).toBe(true);
        if (!rr.ok) throw new Error(rr.problem);
        const rec = rr.record;
        expect(rec.kind).toBe("mocksoc");
        expect(rec.outcome).toBe("success");
        expect(rehearsalSatisfiesStage(rec)).toBe(true);
        const sha = createHash("sha256").update(readFileSync(pulse)).digest("hex");
        expect(rec.pulse_hash).toBe(`sha256:${sha}`);
        expect(rec.mismatch).toMatch(/delta × 1\.05/);
        expect(rec.step_outcome).toMatch(/IdentityStrategy step/);
        rmSync(root, { recursive: true, force: true });
      },
      900_000,
    );

    it(
      "a corrupt pulse fails the rehearsal DISTINCTLY: artifact written, exit 1, outcome failed, stage NOT satisfied",
      () => {
        const root = mkdtempSync(join(tmpdir(), "rehearsal-fail-"));
        const badPulse = join(root, "pulse.jld2");
        writeFileSync(badPulse, "not a jld2 file");
        const result = join(__dirname, "..", "fixtures", "mocksoc", "result-params.toml"); // real [params] shape; the PULSE is what fails
        const outDir = join(root, "rehearsal");
        let code = 0;
        let rehOut = "";
        try {
          rehOut = execFileSync(
            JULIA,
            ["--startup-file=no", `--project=${REHEARSAL_PROJECT}`, REHEARSAL_SCRIPT, badPulse, result, outDir],
            { encoding: "utf8", timeout: 300_000 },
          );
        } catch (e) {
          code = (e as { status?: number }).status ?? 1;
          rehOut = String((e as { stdout?: string }).stdout ?? "");
        }
        expect(code).not.toBe(0); // a failed rehearsal is never a quiet success
        expect(rehOut).toMatch(/REHEARSAL outcome=failed/);
        const rr = readRehearsalRecord(join(outDir, "rehearsal.toml"));
        expect(rr.ok).toBe(true);
        if (!rr.ok) throw new Error(rr.problem);
        expect(rr.record.outcome).toBe("failed");
        expect(rr.record.error).toBeTruthy();
        expect(rehearsalSatisfiesStage(rr.record)).toBe(false); // the stage stays an honest stub
        rmSync(root, { recursive: true, force: true });
      },
      300_000,
    );
  },
);
