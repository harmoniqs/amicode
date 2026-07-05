#!/usr/bin/env julia
# Golden-fixture generator for verify_rollout.jl (spec-20260704-113005 §4/§9).
# Builds a REAL 2-subsystem EmbeddedOperator with UNEQUAL levels [2,3] (a qubit ⊗
# a qutrit), rolls out an unsolved trajectory, and writes a run dir whose reported
# fidelity is computed with the rydberg EXEMPLAR's explicit virtual-Z convention.
# The harness must reproduce it from pulse_dense.jld2 using its GENERAL
# binary-decomposition builder — so agreement validates that builder against the
# shipped convention, on unequal levels. No solve (fast); the point is the phase
# convention + dense precedence + serialization round-trip, not gate quality.
# Usage: julia --project=<env> make_verify_golden.jl <out_dir>
using Piccolo
using JLD2, TOML
using LinearAlgebra

function main(out_dir::String)
    mkpath(out_dir)

    # qubit (2) ⊗ qutrit (3), dim 6
    σx2 = ComplexF64[0 1; 1 0]; σy2 = ComplexF64[0 -im; im 0]; I2 = Matrix{ComplexF64}(I, 2, 2)
    σx3 = ComplexF64[0 1 0; 1 0 0; 0 0 0]; σy3 = ComplexF64[0 -im 0; im 0 0; 0 0 0]; I3 = Matrix{ComplexF64}(I, 3, 3)
    Hx = kron(σx2, I3) + kron(I2, σx3)
    Hy = kron(σy2, I3) + kron(I2, σy3)
    H_drift = zeros(ComplexF64, 6, 6)
    drive_bounds = [(-1.0, 1.0), (-1.0, 1.0)]
    sys = QuantumSystem(H_drift, [Hx, Hy], drive_bounds)

    # CZ on {|0⟩,|1⟩}⊗{|0⟩,|1⟩} embedded in [2,3] = 6-dim.
    op = EmbeddedOperator(GATES[:CZ], [1, 2], [1:2, 1:2], [2, 3])

    N = 21
    times = collect(range(0.0, 1.0, length = N))
    # deterministic init (no randn) — the trajectory is saved, so the harness
    # re-rolls this exact one either way.
    initial = 0.1 .* [sin(2π * (k + d) / N) for d = 1:sys.n_drives, k = 1:N]
    qtraj = UnitaryTrajectory(sys, ZeroOrderPulse(initial, times), op)
    qcp = SmoothPulseProblem(qtraj, N;
        piccolo_options = PiccoloOptions(timesteps_all_equal = true), Q = 100.0, R = 1e-2)
    traj = get_trajectory(qcp)   # initial-guess trajectory (NOT solved)

    # both artifacts saved; harness prefers pulse_dense.jld2 (same knots here — the
    # golden tests convention + precedence, not spline resampling).
    JLD2.save(joinpath(out_dir, "pulse.jld2"), "traj", traj)
    JLD2.save(joinpath(out_dir, "pulse_dense.jld2"), "traj", traj)

    Uroll = iso_vec_to_operator(unitary_rollout(traj, sys)[:, end])

    # reported free-phase fidelity. unitary_fidelity restricts BOTH args to
    # `subspace`, so the goal must be FULL-space with the virtual-Z applied to its
    # computational block (the exemplar's bare 4×4 form BoundsErrors — that report
    # block never ran; the exemplar never solved). The phase vector here is written
    # EXPLICITLY in basis order [00,01,10,11] — independent of the harness's general
    # binary-decomposition builder, so agreement validates that builder.
    φ1, φ2 = 0.3, -0.9
    sub = collect(op.subspace)
    goal = copy(op.operator)
    goal[sub, sub] = Diagonal(ComplexF64[1, exp(im * φ2), exp(im * φ1), exp(im * (φ1 + φ2))]) * goal[sub, sub]
    fid = unitary_fidelity(Uroll, goal; subspace = sub)

    JLD2.save(joinpath(out_dir, "system_verify.jld2"),
        "goal_kind", "unitary", "goal", op.operator, "subspace", collect(op.subspace),
        "H_drift", H_drift, "H_drives", [Hx, Hy], "drive_bounds", drive_bounds)

    open(joinpath(out_dir, "result.toml"), "w") do io
        TOML.print(io, Dict(
            "schema_version" => "1", "fidelity" => fid, "iterations" => 0,
            "pulse_kind" => "spline", "fidelity_convention" => "free_phase",
            "free_phases" => [φ1, φ2], "subsystem_levels" => [2, 3]))
    end
    println("GOLDEN out=$(out_dir) reported=$(fid)")
end

main(ARGS[1])
