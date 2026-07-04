#!/usr/bin/env julia
# Amicode verification harness (spec C + spec-20260704-113005 §6) — FIXED, VETTED
# ASSET. Usage: julia --project=<env> verify_rollout.jl <run_dir> [tolerance]
#
# Independently re-checks a run's reported fidelity by re-rolling its pulse with
# Piccolo's NATIVE unitary_rollout + unitary_fidelity — the same idiom as the
# vetted template tail and the rydberg exemplar report block. The independence
# the trust chain needs is from the AUTHORED SCRIPT's optimizer transcription,
# NOT from Piccolo: no custom integration code by design (Aaron directive
# 2026-07-03). Shipped with the extension, never model-authored.
#
# spec-20260704-113005 §6 additions:
#   - pulse_kind dispatch: a "spline" solve MUST emit pulse_dense.jld2 (a densely
#     resampled trajectory) — re-rolling the sparse knots as PWC hits the
#     spline-vs-bare-rollout cliff. Precedence: dense present → re-roll dense;
#     pulse_kind="spline" but dense absent → FAIL CLOSED (missing_dense_pulse);
#     otherwise the plain pulse.jld2 path (unchanged).
#   - free-phase: when fidelity_convention="free_phase", apply the optimized
#     per-qubit virtual-Z phases POST-HOC to the goal (never in dynamics), using
#     Piccolo's exact convention — the phase on computational basis |b₁…b_n⟩ is
#     Σ_j φ[j]·b_j (binary decomposition; rollouts_extensions.jl:906-914, matching
#     the rydberg exemplar's Diagonal([1,e^{iφ₂},e^{iφ₁},e^{i(φ₁+φ₂)}])·gate).
using JLD2, TOML
using Piccolo
using LinearAlgebra

function write_verification(run_dir::String, fields::Dict)
    open(joinpath(run_dir, "verification.toml.tmp"), "w") do io
        TOML.print(io, fields)
    end
    mv(joinpath(run_dir, "verification.toml.tmp"), joinpath(run_dir, "verification.toml"); force = true)
end

# Per-qubit virtual-Z phase diagonal over the computational subspace, in the
# subspace's basis order (standard binary: |0…0⟩, …, |1…1⟩). Matches
# Rollouts.fidelity(qtraj; phases) and the rydberg exemplar's virtual-Z scan.
function free_phase_diag(phases::Vector{Float64}, n_sub::Int)
    nq = length(phases)
    return ComplexF64[
        exp(im * sum(phases[j] for j = 1:nq if ((i - 1) >> (nq - j)) & 1 == 1; init = 0.0))
        for i = 1:n_sub
    ]
end

function main(run_dir::String, tol::Float64)
    result = try TOML.parsefile(joinpath(run_dir, "result.toml")) catch; Dict{String,Any}() end
    pulse_kind = get(result, "pulse_kind", "pwc")
    dense_path = joinpath(run_dir, "pulse_dense.jld2")

    # ── pulse-artifact precedence (spec §6) ──
    local traj, integrator_tag
    if isfile(dense_path)
        traj = JLD2.load(dense_path, "traj")
        integrator_tag = "piccolo_unitary_rollout_dense"
    elseif pulse_kind == "spline"
        write_verification(run_dir, Dict(
            "schema_version" => "1", "agree" => false,
            "fidelity_rerolled" => "nan", "fidelity_reported" => get(result, "fidelity", "nan"),
            "tolerance" => tol, "integrator" => "none",
            "error" => "missing_dense_pulse",
            "checked_at" => string(round(Int, time()))))
        println("VERIFY agree=false error=missing_dense_pulse")
        return
    else
        traj = JLD2.load(joinpath(run_dir, "pulse.jld2"), "traj")
        integrator_tag = "piccolo_unitary_rollout"
    end

    sv = JLD2.load(joinpath(run_dir, "system_verify.jld2"))
    sys = QuantumSystem(sv["H_drift"], sv["H_drives"], sv["drive_bounds"])

    fid = if sv["goal_kind"] == "unitary"
        Uroll = iso_vec_to_operator(unitary_rollout(traj, sys)[:, end])
        sub = haskey(sv, "subspace") ? collect(Int, sv["subspace"]) : nothing
        goal = sv["goal"]
        # ── free-phase post-hoc (spec §6): phases NEVER enter dynamics ──
        if get(result, "fidelity_convention", "fixed") == "free_phase" && sub !== nothing
            phases = Float64.(result["free_phases"])
            goal = copy(goal)
            goal[sub, sub] = Diagonal(free_phase_diag(phases, length(sub))) * goal[sub, sub]
        end
        sub === nothing ? unitary_fidelity(Uroll, goal) : unitary_fidelity(Uroll, goal; subspace = sub)
    else
        ψroll = rollout(sv["initial_state"], traj, sys)[:, end]
        fidelity(ψroll, sv["goal"])
    end

    reported = try Float64(result["fidelity"]) catch; NaN end
    agree = isfinite(reported) && abs(fid - reported) <= tol
    write_verification(run_dir, Dict(
        "schema_version" => "1",
        "fidelity_rerolled" => fid, "fidelity_reported" => reported,
        "tolerance" => tol, "agree" => agree,
        "integrator" => integrator_tag,
        "checked_at" => string(round(Int, time()))))
    println("VERIFY agree=$(agree) rerolled=$(fid) reported=$(reported)")
end

main(ARGS[1], length(ARGS) >= 2 ? parse(Float64, ARGS[2]) : 0.001)
