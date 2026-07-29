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
δ          = 0.2        # anharmonicity (GHz, positive convention)
levels     = 3          # transmon levels modeled (3 = qubit + 1 leakage; bump to 4–5 for more leakage realism)
gate       = GATES[:X]
T          = 10.0       # gate time (ns)
N          = 50         # timesteps
drive_max  = 0.2        # per-quadrature drive bound (GHz)
max_iter   = 60
SOLVER     = :ipopt     # :ipopt (default) or :altissimo (High-Performance + Cloud)
# ─────────────────────────────────────────────────────────────────────────

SOLVER in (:ipopt, :altissimo) || error("SOLVER must be :ipopt or :altissimo, got $SOLVER")
if SOLVER === :altissimo
    @eval using Piccolissimo   # AltissimoOptions lives here, not in Piccolo
end

# ── telemetry sink ───────────────────────────────────────────────────────────
# Every AMICODE_* line goes to stdout AND, on a cloud run, to `run.log` in the
# run dir (== cwd).
#
# Why the file: the cloud poller's /solves/<id>/stats parses AMICODE_ITER lines
# out of `run.log` in the artifact prefix, and the runner's sidecar populates that
# prefix with `aws s3 sync .` — it uploads whatever is in the cwd. But julia's
# stdout on the runner goes to the SSM command stream, so no `run.log` was ever
# written there: nothing to sync, `stats: []`, and an empty Run Inspector even
# though the solve was streaming perfectly (verified on tasks 419a57e6 and
# 0fccbbf9 — frames landed, iterations did not).
#
# Why gated on a cloud run: LOCALLY amico-run's executor already writes run.log
# from our stdout, so appending here too would DOUBLE every line and the
# inspector would count each iteration twice. TASK_ID is exported by the runner's
# SendCommand and never set by a local run.
const CLOUD_RUN = haskey(ENV, "TASK_ID")
function emit(line::AbstractString)
    println(line)
    flush(stdout)
    if CLOUD_RUN
        try
            open("run.log", "a") do io
                println(io, line)
            end
        catch e
            @warn "run.log append failed" exception = e maxlog = 3   # telemetry never kills a solve
        end
    end
    return nothing
end

sys = TransmonSystem(; δ = δ, levels = levels, drive_bounds = fill(drive_max, 2))
op  = size(gate, 1) == sys.levels ? gate : EmbeddedOperator(gate, sys)

times   = collect(range(0.0, T, length = N))
initial = 0.1 * randn(sys.n_drives, N)
qtraj = UnitaryTrajectory(sys, ZeroOrderPulse(initial, times), op)
qcp = SmoothPulseProblem(qtraj, N;
    piccolo_options = PiccoloOptions(timesteps_all_equal = true),
    Q = 100.0, R = 1e-2)
prob = hasproperty(qcp, :prob) ? qcp.prob : qcp

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
    # Cooperative stop: the Run Inspector's Stop button drops a STOP file into the
    # run dir (== cwd). Returning false from Ipopt's intermediate_callback halts
    # the solve (User_Requested_Stop) at the next iteration; solve! returns
    # normally, so the partial pulse.jld2/result.toml still get written below.
    if isfile("STOP")
        emit("AMICODE_STOPPED")
        return false
    end
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
            emit(@sprintf("AMICODE_PULSE iter=%d dt=%.6g a=%s", iter, first(Piccolo.get_timesteps(traj)), vals))
        end
    catch e
        @warn "pulse emit failed" exception = e maxlog = 3   # never let telemetry kill the solve
    end
    return ok
end
pulse_emit = PulseEmitCallback(live_plot, prob.trajectory)

let ls = join(("\"a_$i\"" for i in 1:sys.n_drives), ","),
    bs = join(("$(-drive_max):$(drive_max)" for _ in 1:sys.n_drives), ",")
    emit("AMICODE_PULSE_META drives=$(sys.n_drives) knots=$N labels=$ls bounds=$bs")
end

# On IPOPT, AMICODE_ITER rides the RAW Ipopt callback — it needs the rich IPM
# state (obj_value/inf_pr/inf_du) that the agnostic `(primal, iter)` contract
# doesn't carry. Both callbacks fire once per iteration (DTO composes the raw
# callback with `intermediate_callback`).
const CB = Piccolo.Callbacks
iters = Ref(0)
function cb_log(optimizer, st; kwargs...)
    k = Int(st.iter_count); iters[] = k
    emit(@sprintf("AMICODE_ITER iter=%d f=%.6e inf_pr=%.3e inf_du=%.3e", k, st.obj_value, st.inf_pr, st.inf_du))
    return true
end

# Altissimo carries no `intermediate_callback` — its only per-iteration hook is
# the `callback` kwarg on `Altissimo.optimize!`, which Piccolissimo forwards from
# `solve!(::AltissimoOptions)`, and it arrives as `(x, info)` rather than
# `(optimizer, IpoptOptimizerState)`. So BOTH channels have to be re-hung here:
# without this the frames stop too (they come off IpoptOptions), and an Altissimo
# solve leaves the Run Inspector completely dark rather than merely numberless.
#
# `x` IS the primal, so pulse_emit's solver-agnostic `(primal, iter)` contract
# takes it unchanged — same frames, same AMICODE_PULSE lines, same STOP handling
# (returning false stops an Altissimo solve exactly as it stops an Ipopt one).
#
# inf_pr/inf_du come from Altissimo's callback tuple. Newer builds expose them
# directly (Altissimo#414); older ones carry only eq_viol/ineq_viol/kkt_error, so
# derive from those rather than emitting NaN — a real number the client can plot
# beats a placeholder it has to special-case.
function alt_cb(x, info)
    k = Int(info.outer_iter); iters[] = k
    ok = pulse_emit(x, k)   # frames + AMICODE_PULSE + cooperative STOP
    inf_pr = haskey(info, :inf_pr) ? info.inf_pr : max(info.eq_viol, info.ineq_viol)
    inf_du = haskey(info, :inf_du) ? info.inf_du : info.kkt_error
    emit(@sprintf("AMICODE_ITER iter=%d f=%.6e inf_pr=%.3e inf_du=%.3e", k, info.f_val, inf_pr, inf_du))
    return ok
end

t0 = time()
if SOLVER === :altissimo
    solve!(qcp; max_iter = max_iter, options = Piccolissimo.AltissimoOptions(), callback = alt_cb)
else
    solve!(qcp; max_iter = max_iter, print_level = 1,
           options = IpoptOptions(intermediate_callback = pulse_emit),
           callback = CB.callback_factory(cb_log))
end
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
    TOML.print(io, Dict(
        "schema_version" => "1",   # run-dir contract version (@amicode/schema result schema)
        "fidelity" => fid, "iterations" => iters[], "wall_seconds" => wall,
        "params" => Dict("delta" => δ, "levels" => levels, "T" => T, "N" => N,
                         "drive_max" => drive_max, "max_iter" => max_iter),
    ))
end
mv("result.toml.tmp", "result.toml"; force = true)
emit("DONE fidelity=$(fid)")
