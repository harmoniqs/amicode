import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

// Live golden test for the tier-3 re-rollout harness (spec C). Gated on a real
// Julia+Piccolo project (same gate the template slow test uses). Builds a
// fixture with Piccolo's OWN construction, records the fidelity the harness's
// native re-rollout will reproduce, and asserts agree=true; then corrupts the
// pulse so the harness's re-rollout disagrees → agree=false. This exercises the
// full harness plumbing (jld2 read → QuantumSystem reconstruction →
// unitary_rollout → unitary_fidelity → verification.toml).
const PROJECT = process.env.AMICO_TEST_JULIA_PROJECT;
const HARNESS = join(__dirname, "..", "..", "julia", "verify_rollout.jl");

// Fixture builder (Julia): construct the SAME system the vetted template uses,
// take a pulse, record its native-rollout fidelity, and serialize the tier-3
// verification snapshot + pulse.jld2. `scale` (argv) lets the negative case
// corrupt the SAVED pulse while keeping the recorded fidelity.
const FIXTURE = String.raw`
using Piccolo, JLD2, TOML
run_dir = ARGS[1]; scale = parse(Float64, ARGS[2])
δ = 0.2; levels = 3; T = 10.0; N = 30; drive_max = 0.2
sys = TransmonSystem(; δ = δ, levels = levels, drive_bounds = fill(drive_max, 2))
op  = EmbeddedOperator(GATES[:X], sys)
times = collect(range(0.0, T, length = N))
initial = 0.05 * ones(sys.n_drives, N)          # deterministic, non-random
qtraj = UnitaryTrajectory(sys, ZeroOrderPulse(initial, times), op)
# the NamedTrajectory the harness reads comes from the PROBLEM (template idiom),
# not the UnitaryTrajectory; build the problem but do NOT solve (initial guess).
qcp = SmoothPulseProblem(qtraj, N; piccolo_options = PiccoloOptions(timesteps_all_equal = true), Q = 100.0, R = 1e-2)
prob = hasproperty(qcp, :prob) ? qcp.prob : qcp
traj = prob.trajectory
# fidelity the harness will recompute (identical Piccolo path)
Uroll = iso_vec_to_operator(unitary_rollout(get_trajectory(qcp), sys)[:, end])
fid = unitary_fidelity(Uroll, op.operator; subspace = op.subspace)
open(joinpath(run_dir, "result.toml"), "w") do io
    TOML.print(io, Dict("schema_version" => "1", "fidelity" => fid, "iterations" => 1))
end
# tier-3 verification snapshot (skeleton_free.jl CONTRACT block layout)
JLD2.jldopen(joinpath(run_dir, "system_verify.jld2"), "w") do f
    f["schema"]=1; f["H_drift"]=Matrix{ComplexF64}(get_drift(sys))
    f["H_drives"]=[Matrix{ComplexF64}(H) for H in get_drives(sys)]
    f["goal_kind"]="unitary"; f["goal"]=Matrix{ComplexF64}(op.operator)
    f["subspace"]=collect(Int, op.subspace); f["drive_bounds"]=[Float64(b[2]) for b in sys.drive_bounds]
end
# corrupt the SAVED pulse for the negative case (scale != 1) — the recorded
# fidelity above stays put, so the harness's re-rollout will disagree.
if scale != 1.0
    dname = :u in traj.names ? :u : :a
    Piccolo.NamedTrajectories.update!(traj, dname, scale .* traj[dname])
end
JLD2.save(joinpath(run_dir, "pulse.jld2"), "traj", traj)
println("FIXTURE fid=$(fid)")
`;

function stageAndVerify(scale: number): Record<string, unknown> {
  const runDir = mkdtempSync(join(tmpdir(), "verify-golden-"));
  writeFileSync(join(runDir, "fixture.jl"), FIXTURE);
  execFileSync("julia", [`--project=${PROJECT}`, join(runDir, "fixture.jl"), runDir, String(scale)], {
    encoding: "utf8",
    timeout: 600_000,
  });
  execFileSync("julia", [`--project=${PROJECT}`, HARNESS, runDir, "0.01"], { encoding: "utf8", timeout: 600_000 });
  expect(existsSync(join(runDir, "verification.toml"))).toBe(true);
  return parse(readFileSync(join(runDir, "verification.toml"), "utf8")) as Record<string, unknown>;
}

describe.skipIf(!PROJECT)("slow: verify_rollout.jl golden (spec C tier-3 harness)", () => {
  it("unmodified pulse round-trips with agree=true", () => {
    const v = stageAndVerify(1.0);
    expect(v.integrator).toBe("piccolo_unitary_rollout");
    expect(v.agree).toBe(true);
    expect(Math.abs((v.fidelity_rerolled as number) - (v.fidelity_reported as number))).toBeLessThanOrEqual(0.01);
  }, 600_000);
  it("corrupted pulse (×0.5) → re-rollout disagrees, agree=false", () => {
    const v = stageAndVerify(0.5);
    expect(v.agree).toBe(false);
  }, 600_000);
});
