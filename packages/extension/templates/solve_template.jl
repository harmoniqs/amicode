#!/usr/bin/env julia
# Amicode solve template — fill in the `# FILL IN` block, then:
#   amico-run --project <julia-project> solve.jl
# Emits the run-dir contract (AMICODE_ITER, iter_<N>.png, result.toml, pulse.jld2, DONE).
# Vetted against Piccolo 1.19 (the version `Pkg.add Piccolo` installs today): a
# single-qubit X gate on a 3-level transmon converges to subspace fidelity ~1.0.
using Piccolo
using CairoMakie   # loads PiccoloMakieExt → gives LivePulsePlotCallback its impl
using JLD2
using TOML
using Printf

# ── FILL IN ──────────────────────────────────────────────────────────────
δ           = 0.2        # anharmonicity (GHz, positive convention)
levels      = 3          # transmon levels modeled (3 = qubit + 1 leakage; bump to 4–5 for more leakage realism)
gate        = GATES[:X]
gate_name   = "X"        # DECLARED gate label — GATES[:X] is a matrix, so the ":X" name is lost above; declare it so formulation.toml can record it
system_name = nothing    # optional user-assigned device name (e.g. "qram-cleland"); nothing if unnamed
T           = 10.0       # gate time (ns)
N           = 50         # timesteps
drive_max   = 0.2        # per-quadrature drive bound (GHz)
max_iter    = 60
# ─────────────────────────────────────────────────────────────────────────

sys = TransmonSystem(; δ = δ, levels = levels, drive_bounds = fill(drive_max, 2))
op  = size(gate, 1) == sys.levels ? gate : EmbeddedOperator(gate, sys)

times   = collect(range(0.0, T, length = N))
initial = 0.1 * randn(sys.n_drives, N)
qtraj = UnitaryTrajectory(sys, ZeroOrderPulse(initial, times), op)
Q = 100.0   # infidelity objective weight — defines the optimum (recorded in formulation.toml)
R = 1e-2    # control-effort objective weight — defines the optimum (recorded in formulation.toml)
qcp = SmoothPulseProblem(qtraj, N;
    piccolo_options = PiccoloOptions(timesteps_all_equal = true),
    Q = Q, R = R)
prob = hasproperty(qcp, :prob) ? qcp.prob : qcp

# Pre-solve run-dir emit helper: writes formulation.toml (the DECLARED problem —
# physics + objective), the authoritative identity source #64 keys hashes off.
# Defined INLINE — NOT include(joinpath(@__DIR__, "...")): AGENTS.md deploys this
# template by copying THIS FILE ALONE into a scratch dir and running the copy, so
# @__DIR__ is that scratch dir and a sibling include resolves to a file that was
# never copied (LoadError before solve!). When a second template needs this, lift
# it verbatim into a Julia package (AmicoRunDir.jl) resolved via `using` — the only
# share mechanism that survives the single-file copy.
#
# Contract (validated by @amicode/schema formulation.schema.json):
#   [system]      family (required) + optional name + family-dependent params
#   [formulation] gate + T + N (required) + optional Q/R + family-dependent extras
# system_params / formulation_extra are merged per family (the schema constrains
# known families but tolerates unknown leaves), so a rydberg caller can pass
# Omega_max/C6/... with no edit here.
function emit_formulation(;
    system_family::AbstractString,
    gate_name::AbstractString,
    system_params::AbstractDict = Dict{String,Any}(),
    system_name::Union{AbstractString,Nothing} = nothing,
    formulation_extra::AbstractDict = Dict{String,Any}(),
    path::AbstractString = "formulation.toml",
)
    system = Dict{String,Any}("family" => String(system_family))
    if system_name !== nothing
        system["name"] = String(system_name)
    end
    for (k, v) in system_params
        system[String(k)] = v
    end

    formulation = Dict{String,Any}("gate" => String(gate_name))
    for (k, v) in formulation_extra
        formulation[String(k)] = v
    end

    doc = Dict{String,Any}(
        "schema_version" => "1",   # run-dir contract version (@amicode/schema formulation schema)
        "system" => system,
        "formulation" => formulation,
    )

    tmp = path * ".tmp"
    open(tmp, "w") do io
        TOML.print(io, doc)
    end
    mv(tmp, path; force = true)   # atomic swap — a partial read never sees a half-written file
    return path
end

# Per-iter live plot flows through Piccolo's `LivePulsePlotCallback`, an
# `AbstractIntermediateCallback` (the blessed, solver-agnostic per-iter plot
# idiom — see AGENTS.md). It reconstructs the pulse from the optimizer's primal
# each iteration and writes `iter_<N>.png` into the run dir; the Run Inspector
# reads those frames. `every` is the redraw cadence. (No hand-rolled plotting:
# the PNGs are the callback's job, not the script's.)
const PLOT_EVERY = 6
live_plot = LivePulsePlotCallback(qtraj, prob.trajectory; every = PLOT_EVERY, save_dir = ".")

# Pulse-data telemetry (#66, prototype-grade): raw knot values per iteration as
# AMICODE_PULSE lines on stdout (→ run.log), riding the SAME solver-agnostic
# (primal, iter) hook as the live plot — the inspector renders them natively.
# Additive to the run-dir contract: consumers that don't know the lines ignore
# them. META once (shape + bounds), then one record per iteration (~1KB).
struct PulseEmitCallback <: AbstractIntermediateCallback
    inner::Any   # delegate (the live plot) — fires first, keeps the PNG cadence
    traj::Any    # prob.trajectory — synced from the primal, then read
end
function (cb::PulseEmitCallback)(primal, iter)
    ok = cb.inner(primal, iter)
    try
        traj = cb.traj
        expected = traj.dim * traj.N + traj.global_dim
        if length(primal) == expected
            # Own sync — the delegate only updates the trajectory on its plot cadence.
            # Qualified: `update!` is also exported by Makie/CairoMakie — the
            # unqualified binding is ambiguous once the plotting stack loads.
            if traj.global_dim > 0
                Piccolo.NamedTrajectories.update!(traj, collect(view(primal, 1:expected)); type = :both)
            else
                Piccolo.NamedTrajectories.update!(traj, collect(view(primal, 1:(traj.dim * traj.N))); type = :data)
            end
            # Drive component name differs by problem flavor (:u current, :a
            # legacy). Membership check (not `something(traj.u, traj.a)`): it
            # keeps the fallback reachable without leaning on property access
            # returning `nothing` for missing components (review nit, #67).
            A = :u in traj.names ? traj.u : (:a in traj.names ? traj.a : missing)
            A === missing && error("no drive component (:u/:a) on trajectory")
            vals = join((join((@sprintf("%.6g", v) for v in row), ",") for row in eachrow(A)), ";")
            @printf("AMICODE_PULSE iter=%d dt=%.6g a=%s\n", iter, first(Piccolo.get_timesteps(traj)), vals)
            flush(stdout)
        end
    catch e
        @warn "pulse emit failed" exception = e maxlog = 3   # never let telemetry kill the solve
    end
    return ok
end
pulse_emit = PulseEmitCallback(live_plot, prob.trajectory)

let ls = join(("\"a_$i\"" for i in 1:sys.n_drives), ","),
    bs = join(("$(-drive_max):$(drive_max)" for _ in 1:sys.n_drives), ",")
    println("AMICODE_PULSE_META drives=$(sys.n_drives) knots=$N labels=$ls bounds=$bs")
    flush(stdout)
end

# Pre-solve: drop formulation.toml — the DECLARED problem (physics + objective),
# written before solve! while every FILL-IN var is in scope. Authoritative
# identity source (#64 keys hashes off this); [system] = the device, [formulation]
# = the optimal-control problem posed against it.
emit_formulation(;
    system_family = "transmon",
    gate_name = gate_name,
    system_name = system_name,
    system_params = Dict("delta" => δ, "levels" => levels, "drive_max" => drive_max),
    formulation_extra = Dict("T" => T, "N" => N, "Q" => Q, "R" => R),
)

# AMICODE_ITER text telemetry stays on the RAW Ipopt callback — it needs the rich
# IPM state (obj_value/inf_pr/inf_du) that the agnostic `(primal, iter)` contract
# doesn't carry. Both callbacks fire once per iteration (DTO composes the raw
# callback with `intermediate_callback`); the live inspector is ipopt-only (Q74).
const CB = Piccolo.Callbacks
iters = Ref(0)
function cb_log(optimizer, st; kwargs...)
    k = Int(st.iter_count); iters[] = k
    @printf("AMICODE_ITER iter=%d f=%.6e inf_pr=%.3e inf_du=%.3e\n", k, st.obj_value, st.inf_pr, st.inf_du)
    flush(stdout)
    return true
end

t0 = time()
solve!(qcp; max_iter = max_iter, print_level = 1,
       options = IpoptOptions(intermediate_callback = pulse_emit),
       callback = CB.callback_factory(cb_log))
wall = time() - t0

# Fidelity over the COMPUTATIONAL subspace, from a fresh high-tolerance rollout.
# Two reasons this is the right metric:
#   - subspace (not full-space): the embedded goal pins identity on the leakage
#     level, which the solve doesn't enforce — full-space would read ~0.44 even
#     for a perfect qubit gate. We want the gate fidelity on {|0>,|1>}.
#   - rollout (not the raw final propagator): re-integrating at 1e-8 yields a
#     clean unitary, avoiding the ~1e-6 norm-drift that made the raw block read >1.
Uroll = iso_vec_to_operator(unitary_rollout(get_trajectory(qcp), sys)[:, end])
fid   = unitary_fidelity(Uroll, op.operator; subspace = op.subspace)

# End-of-solve guarantee frame — STILL through LivePulsePlotCallback (no bespoke
# plot). The live callback fires at iters 0, PLOT_EVERY, 2·PLOT_EVERY, …; a solve
# that converges in < PLOT_EVERY iters would otherwise leave only the iter-0
# random-init frame (inspector stuck showing the initial guess). Re-invoke the
# callback once at every=1 with the FINAL primal so the last frame is the
# converged pulse. prob.trajectory is the final iterate here (DTO synced it after
# solve!), so this reconstructs the same primal the callback saw per-iter.
let final_cb = LivePulsePlotCallback(qtraj, prob.trajectory; every = 1, save_dir = ".")
    tr = prob.trajectory
    final_primal = tr.global_dim > 0 ? vcat(collect(tr.datavec), collect(tr.global_data)) : collect(tr.datavec)
    final_cb(final_primal, iters[])
end

JLD2.save("pulse.jld2", "traj", prob.trajectory)   # key "traj" so `load_traj` can reload it (warm-start)
open("result.toml.tmp", "w") do io
    # Record the regime each run actually solved (scalar FILL-IN params), so the
    # result is self-describing — not just fidelity/iterations.
    # NOTE: [params] is now REDUNDANT with the pre-solve formulation.toml (the
    # authoritative problem-definition file). Kept for now so in-flight consumers
    # (#73 card reads params.T/params.system) don't break; killing it is a
    # follow-up once those readers migrate to formulation.toml (tracked in #64).
    TOML.print(io, Dict(
        "schema_version" => "1",   # run-dir contract version (@amicode/schema result schema)
        "fidelity" => fid, "iterations" => iters[], "wall_seconds" => wall,
        "params" => Dict("delta" => δ, "levels" => levels, "T" => T, "N" => N,
                         "drive_max" => drive_max, "max_iter" => max_iter),
    ))
end
mv("result.toml.tmp", "result.toml"; force = true)
println("DONE fidelity=$(fid)"); flush(stdout)
