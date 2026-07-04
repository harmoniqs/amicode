#!/usr/bin/env julia
# Amicode tier-3 verification harness (spec C) — FIXED, VETTED ASSET.
# Usage: julia --project=<env> verify_rollout.jl <run_dir> [tolerance]
#
# Reads system_verify.jld2 (+ pulse.jld2 "traj") from the run dir and re-checks
# the reported fidelity with Piccolo's NATIVE re-rollout — the same
# unitary_rollout + unitary_fidelity idiom as the vetted template's tail, and
# the ground-truth path that catches optimizer-vs-rollout divergence. The
# independence the trust chain needs is from the AUTHORED SCRIPT's optimizer
# transcription, NOT from Piccolo: this harness contains no custom integration
# code by design (Aaron directive 2026-07-03). It is shipped with the extension
# and never model-authored.
using JLD2, TOML
using Piccolo

function main(run_dir::String, tol::Float64)
    sv = JLD2.load(joinpath(run_dir, "system_verify.jld2"))
    traj = JLD2.load(joinpath(run_dir, "pulse.jld2"), "traj")

    # native reconstruction from the serialized generators (3-arg matrix ctor:
    # drift, drives, drive_bounds)
    sys = QuantumSystem(sv["H_drift"], sv["H_drives"], sv["drive_bounds"])

    fid = if sv["goal_kind"] == "unitary"
        # native re-rollout, template idiom (solve_template.jl tail). The goal is
        # serialized FULL-space; unitary_fidelity(U, U_goal; subspace) restricts
        # both to the computational subspace itself (dynamics.jl:291).
        Uroll = iso_vec_to_operator(unitary_rollout(traj, sys)[:, end])
        if haskey(sv, "subspace")
            unitary_fidelity(Uroll, sv["goal"]; subspace = collect(Int, sv["subspace"]))
        else
            unitary_fidelity(Uroll, sv["goal"])
        end
    else
        ψroll = rollout(sv["initial_state"], traj, sys)[:, end]
        fidelity(ψroll, sv["goal"])
    end

    reported = try TOML.parsefile(joinpath(run_dir, "result.toml"))["fidelity"] catch; NaN end
    agree = isfinite(reported) && abs(fid - reported) <= tol

    open(joinpath(run_dir, "verification.toml.tmp"), "w") do io
        TOML.print(io, Dict(
            "schema_version" => "1",
            "fidelity_rerolled" => fid,
            "fidelity_reported" => reported,
            "tolerance" => tol,
            "agree" => agree,
            "integrator" => "piccolo_unitary_rollout",
            "checked_at" => string(round(Int, time())),
        ))
    end
    mv(joinpath(run_dir, "verification.toml.tmp"), joinpath(run_dir, "verification.toml"); force = true)
    println("VERIFY agree=$(agree) rerolled=$(fid) reported=$(reported)")
end

main(ARGS[1], length(ARGS) >= 2 ? parse(Float64, ARGS[2]) : 0.01)
