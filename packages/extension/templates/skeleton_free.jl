#!/usr/bin/env julia
# Amicode TIER-3 FREE-AUTHORING skeleton (spec C). Author the physics in the
# marked `# ── AUTHOR ──` sections; NEVER edit the `# ── CONTRACT ──` blocks —
# they are the frozen run-dir contract (AMICODE_ITER / AMICODE_PULSE / iter PNGs
# / pulse.jld2 / result.toml / DONE) plus the tier-3 verification snapshot the
# fixed re-rollout harness checks. Launch through the gate:
#   amico-run --spec solvespec.json --project <sandbox-env> solve.jl
# Results are UNTRUSTED until verification.toml records agree = true.
using Piccolo
using CairoMakie   # loads PiccoloMakieExt → gives LivePulsePlotCallback its impl
using JLD2
using TOML
using Printf

# ── AUTHOR: system + goal ─────────────────────────────────────────────────
# Build your QuantumSystem and target. Define, at minimum:
#   sys        :: QuantumSystem
#   op         :: the goal — an EmbeddedOperator (has .operator + .subspace) OR
#                a bare Operator/Matrix on the full space
#   N          :: Int, timesteps
#   T          :: Float64, total time
#   drive_max  :: Float64, per-quadrature drive bound
#   max_iter   :: Int
# Example (single-qubit X on a 3-level transmon):
#   δ = 0.2; levels = 3; T = 10.0; N = 50; drive_max = 0.2; max_iter = 60
#   sys = TransmonSystem(; δ = δ, levels = levels, drive_bounds = fill(drive_max, 2))
#   op  = EmbeddedOperator(GATES[:X], sys)
# ──────────────────────────────────────────────────────────────────────────

# ── AUTHOR: trajectory + problem ──────────────────────────────────────────
# Build the trajectory + optimization problem. Define `qtraj`, `qcp`, and:
#   prob = hasproperty(qcp, :prob) ? qcp.prob : qcp
# Example:
#   times   = collect(range(0.0, T, length = N))
#   initial = 0.1 * randn(sys.n_drives, N)
#   qtraj = UnitaryTrajectory(sys, ZeroOrderPulse(initial, times), op)
#   qcp = SmoothPulseProblem(qtraj, N; piccolo_options = PiccoloOptions(timesteps_all_equal = true), Q = 100.0, R = 1e-2)
#   prob = hasproperty(qcp, :prob) ? qcp.prob : qcp
# ──────────────────────────────────────────────────────────────────────────

# ── CONTRACT: verification snapshot (DO NOT EDIT) ──────────────────────────
# Serialize the CONSTRUCTED problem so the fixed, vetted re-rollout harness can
# re-check the reported fidelity independently (spec C tier-3 verification).
# The AUTHOR sections above must have produced `sys` and `op`; this reads the
# generators + goal off them, full-space, and records the computational subspace.
let goal_is_embedded = isdefined(Main, :op) && hasproperty(op, :operator) && hasproperty(op, :subspace)
    U_goal_full = goal_is_embedded ? Matrix{ComplexF64}(op.operator) : Matrix{ComplexF64}(op isa AbstractMatrix ? op : op.operator)
    subspace_idx = goal_is_embedded ? collect(Int, op.subspace) : collect(1:size(U_goal_full, 1))
    # get_drift/get_drives return the bare Hamiltonian MATRICES (sys.H_drift /
    # sys.H_drives hold internal DriftTerm/LinearDrive wrappers). drive_bounds is
    # stored as (lo,hi) tuples; the harness only needs magnitudes to reconstruct.
    JLD2.jldopen("system_verify.jld2", "w") do f
        f["schema"]       = 1
        f["H_drift"]      = Matrix{ComplexF64}(get_drift(sys))
        f["H_drives"]     = [Matrix{ComplexF64}(H) for H in get_drives(sys)]
        f["goal_kind"]    = "unitary"
        f["goal"]         = U_goal_full
        f["subspace"]     = subspace_idx
        f["drive_bounds"] = [Float64(b[2]) for b in sys.drive_bounds]
    end
end
# ──────────────────────────────────────────────────────────────────────────

# ── CONTRACT: telemetry + solve + artifacts (DO NOT EDIT) ──────────────────
const PLOT_EVERY = 6
live_plot = LivePulsePlotCallback(qtraj, prob.trajectory; every = PLOT_EVERY, save_dir = ".")

struct PulseEmitCallback <: AbstractIntermediateCallback
    inner::Any
    traj::Any
end
function (cb::PulseEmitCallback)(primal, iter)
    # Cooperative stop: the Run Inspector's Stop button drops a STOP file into the
    # run dir (== cwd). Returning false from Ipopt's intermediate_callback halts
    # the solve (User_Requested_Stop) at the next iteration; solve! returns
    # normally, so the partial pulse.jld2/result.toml still get written below.
    if isfile("STOP")
        println("AMICODE_STOPPED"); flush(stdout)
        return false
    end
    ok = cb.inner(primal, iter)
    try
        traj = cb.traj
        expected = traj.dim * traj.N + traj.global_dim
        if length(primal) == expected
            if traj.global_dim > 0
                Piccolo.NamedTrajectories.update!(traj, collect(view(primal, 1:expected)); type = :both)
            else
                Piccolo.NamedTrajectories.update!(traj, collect(view(primal, 1:(traj.dim * traj.N))); type = :data)
            end
            A = :u in traj.names ? traj.u : (:a in traj.names ? traj.a : missing)
            A === missing && error("no drive component (:u/:a) on trajectory")
            vals = join((join((@sprintf("%.6g", v) for v in row), ",") for row in eachrow(A)), ";")
            @printf("AMICODE_PULSE iter=%d dt=%.6g a=%s\n", iter, first(Piccolo.get_timesteps(traj)), vals)
            flush(stdout)
        end
    catch e
        @warn "pulse emit failed" exception = e maxlog = 3
    end
    return ok
end
pulse_emit = PulseEmitCallback(live_plot, prob.trajectory)

let ls = join(("\"a_$i\"" for i in 1:sys.n_drives), ","),
    bs = join(("$(-drive_max):$(drive_max)" for _ in 1:sys.n_drives), ",")
    println("AMICODE_PULSE_META drives=$(sys.n_drives) knots=$N labels=$ls bounds=$bs")
    flush(stdout)
end

const CB = Piccolo.Callbacks
iters = Ref(0)
function cb_log(optimizer, st; kwargs...)
    k = Int(st.iter_count); iters[] = k
    @printf("AMICODE_ITER iter=%d f=%.6e inf_pr=%.3e inf_du=%.3e\n", k, st.obj_value, st.inf_pr, st.inf_du)
    flush(stdout)
    return true
end

t0 = time()
# pulse_emit restored (#177): the pinned DirectTrajOpt 0.9.7 (julia/Manifest.toml
# git-tree-sha1 c722d301a8d0… == tag v0.9.7) declares
# `IpoptOptions.intermediate_callback` — the AbstractIntermediateCallback hook,
# `(primal, iter) -> Bool`, composed with the raw `callback` (all fire per IPM
# iteration). hasfield-guarded (the #157 lesson: DTO ≤ 0.9.6 bundles lack the
# field) so a stale bundle degrades to stats-only instead of crashing the solve.
ipopt_opts = if hasfield(IpoptOptions, :intermediate_callback)
    IpoptOptions(intermediate_callback = pulse_emit)   # → iter_<N>.png + AMICODE_PULSE + STOP poll
else
    @warn "DirectTrajOpt < 0.9.7: no IpoptOptions.intermediate_callback — per-iter frames disabled (AMICODE_ITER still flows)"
    IpoptOptions()
end
solve!(qcp; max_iter = max_iter, print_level = 1,
       options = ipopt_opts,
       callback = CB.callback_factory(cb_log))
wall = time() - t0

Uroll = iso_vec_to_operator(unitary_rollout(get_trajectory(qcp), sys)[:, end])
fid   = hasproperty(op, :operator) ? unitary_fidelity(Uroll, op.operator; subspace = op.subspace) :
                                     unitary_fidelity(Uroll, op isa AbstractMatrix ? op : op.operator)

let final_cb = LivePulsePlotCallback(qtraj, prob.trajectory; every = 1, save_dir = ".")
    tr = prob.trajectory
    final_primal = tr.global_dim > 0 ? vcat(collect(tr.datavec), collect(tr.global_data)) : collect(tr.datavec)
    final_cb(final_primal, iters[])
end

JLD2.save("pulse.jld2", "traj", prob.trajectory)
open("result.toml.tmp", "w") do io
    TOML.print(io, Dict(
        "schema_version" => "1",
        "fidelity" => fid, "iterations" => iters[], "wall_seconds" => wall,
        "params" => Dict("N" => N, "T" => T, "drive_max" => drive_max, "max_iter" => max_iter),
    ))
end
mv("result.toml.tmp", "result.toml"; force = true)
println("DONE fidelity=$(fid)"); flush(stdout)
# ──────────────────────────────────────────────────────────────────────────
