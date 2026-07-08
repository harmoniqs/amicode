import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

// Live golden for the spline/free-phase harness (spec-20260704-113005 §6/§9).
// make_verify_golden.jl builds a REAL qubit⊗qutrit [2,3] EmbeddedOperator (unequal
// levels), writes its free-phase fidelity via an EXPLICIT phase vector, and emits
// pulse_dense.jld2. The harness must reproduce it with its GENERAL
// binary-decomposition builder — agreement validates the convention on unequal
// levels — and must FAIL CLOSED when a spline solve omits the dense pulse.
// (The PWC/fixed-phase path is covered by verify_harness.test.ts, unchanged.)
const PROJECT = process.env.AMICO_TEST_JULIA_PROJECT;
const GEN = join(__dirname, "..", "..", "julia", "make_verify_golden.jl");
const HARNESS = join(__dirname, "..", "..", "julia", "verify_rollout.jl");

function genGolden(): string {
  const dir = mkdtempSync(join(tmpdir(), "verify-fp-"));
  execFileSync("julia", [`--project=${PROJECT}`, GEN, dir], { encoding: "utf8", timeout: 600_000 });
  return dir;
}
function runHarness(dir: string): Record<string, unknown> {
  execFileSync("julia", [`--project=${PROJECT}`, HARNESS, dir, "0.001"], { encoding: "utf8", timeout: 600_000 });
  expect(existsSync(join(dir, "verification.toml"))).toBe(true);
  return parse(readFileSync(join(dir, "verification.toml"), "utf8")) as Record<string, unknown>;
}

describe.skipIf(!PROJECT)("slow: verify_rollout.jl spline + free-phase (spec-20260704-113005 §6/§9)", () => {
  it("dense pulse + free-phase [2,3] → agree=true via the binary-decomposition builder", () => {
    const v = runHarness(genGolden());
    expect(v.integrator).toBe("piccolo_unitary_rollout_dense");
    expect(v.agree).toBe(true);
    expect(Math.abs((v.fidelity_rerolled as number) - (v.fidelity_reported as number))).toBeLessThanOrEqual(0.001);
  }, 600_000);

  it("spline solve with pulse_dense.jld2 missing → fails closed (missing_dense_pulse)", () => {
    const dir = genGolden();
    rmSync(join(dir, "pulse_dense.jld2"));
    const v = runHarness(dir);
    expect(v.agree).toBe(false);
    expect(v.error).toBe("missing_dense_pulse");
    expect(v.integrator).toBe("none");
    expect(v.fidelity_rerolled).toBe("nan"); // string fallback convention (verify.ts writeFallback)
  }, 600_000);
});
