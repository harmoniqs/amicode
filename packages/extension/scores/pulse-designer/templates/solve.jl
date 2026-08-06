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
# ─────────────────────────────────────────────────────────────────────────

# The solver follows the SELECTED SOLVER MODE, substituted at session prep — it is
# NOT an authoring decision. Piccolo mode → :ipopt; Piccolissimo + Altissimo (the
# paid cloud tier) → :altissimo, every run, automatically. Do not hand-edit this:
# the two backends need different callback wiring (below), and a mismatch between
# the selected tier and the solver is how a "High-Performance" run quietly ends up
# on IPOPT.
#
# Written as a substituted STRING rather than a bare `{{SOLVER}}` symbol so that an
# unsubstituted template is still valid Julia: if session prep could not stage a
# copy, this reads as :ipopt (a working local solve) instead of raising a syntax
# error on the placeholder itself.
SOLVER = let s = "{{SOLVER}}"
    Symbol(startswith(s, "{{") ? "ipopt" : s)
end

SOLVER in (:ipopt, :altissimo) || error("SOLVER must be :ipopt or :altissimo, got $SOLVER")
if SOLVER === :altissimo
    @eval using Piccolissimo   # AltissimoOptions lives here, not in Piccolo
    @eval using DirectTrajOpt

    # ── dispatch bridge: DirectTrajOpt 0.9.7 moved the backend extension point ──
    # DTO 0.9.7 renamed it from `Solvers.solve!` to `_solve`, and its fallback only
    # @error-LOGS and returns nothing. Piccolissimo (through 0.2.0) still defines
    # the OLD name, so under 0.9.7 nothing matches and every Altissimo solve is a
    # silent NO-OP that still reports success: `iterations = 0`, fidelity left at
    # the random initial guess, FINISHED completed/exit 0. Verified on this machine
    # (run r20260729-103718Z-12e3: 0 iters, fidelity 0.048, reported "converged").
    #
    # Altissimo is not the bug — its host interface moved out from under it. Until
    # Piccolissimo migrates upstream, bridge it here: the solve script ships per
    # submission, so this reaches the cloud runner with no image rebake.
    #
    # Guard on WHICH method would be called, not on `methods(...)` being empty:
    # DTO has two fallbacks (one typed `Any`, one `AbstractSolverOptions`) and
    # AltissimoOptions matches both, so an emptiness test never installs the bridge.
    _alt_dispatch = try
        m = which(DirectTrajOpt._solve, (DirectTrajOpt.DirectTrajOptProblem, Piccolissimo.AltissimoOptions))
        string(m.sig.parameters[3])
    catch
        "none"
    end
    if _alt_dispatch in ("Any", "AbstractSolverOptions", "DirectTrajOpt.AbstractSolverOptions", "none")
        @eval DirectTrajOpt._solve(
            prob::DirectTrajOpt.DirectTrajOptProblem,
            options::Piccolissimo.AltissimoOptions;
            kwargs...,
        ) = DirectTrajOpt.Solvers.solve!(prob, options; kwargs...)
        println("AMICODE_NOTE bridged AltissimoOptions onto DirectTrajOpt._solve " *
                "(DTO $(pkgversion(DirectTrajOpt)) moved the extension point; was resolving to $_alt_dispatch)")
        flush(stdout)
    end
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
    alt_cb_fired[] = true   # tells the stdout bridge below to stand down (one numbering scheme per run)
    k = Int(info.outer_iter); iters[] = k
    ok = pulse_emit(x, k)   # frames + AMICODE_PULSE + cooperative STOP
    inf_pr = haskey(info, :inf_pr) ? info.inf_pr : max(info.eq_viol, info.ineq_viol)
    inf_du = haskey(info, :inf_du) ? info.inf_du : info.kkt_error
    emit(@sprintf("AMICODE_ITER iter=%d f=%.6e inf_pr=%.3e inf_du=%.3e", k, info.f_val, inf_pr, inf_du))
    return ok
end

# Altissimo telemetry needs TWO independent sources, because neither one is
# reliable across the Piccolissimo versions in the wild:
#   1. alt_cb above — the good path: it carries frames as well as numbers. But it
#      only fires where Piccolissimo forwards a caller `callback` into
#      Altissimo.optimize!. Piccolissimo 0.2.0 declares
#      `solve!(prob, ::AltissimoOptions; kwargs...)` and forwards a HARDCODED
#      whitelist (tol, polish*, …) — `callback` is not on it, so on 0.2.0 and the
#      current cloud image alt_cb never runs at all.
#   2. the stdout bridge below — the floor: Altissimo's own iteration table always
#      prints under `verbose`, on old builds too, so translating those rows into
#      AMICODE_ITER gives the Run Inspector a live curve no matter what the
#      installed Piccolissimo forwards.
# Belt and braces on purpose. With only (1), an Altissimo run on the shipped image
# reports `iterations = 0` and the Inspector stays dark — that is exactly the
# 2026-07-29 failure (fidelity 0.048 reported as a converged result).
#
# Row shapes, both from Altissimo/src/Optimizer.jl:
#   inner step   " %5s  %13.6e  %10.3e  %10.3e  …"   iter column is "·"
#   final outer  " %5d  %13.6e  %10.3e  %10.3e  …"   iter column is the outer index
# Columns 2-4 are objective, inf_pr, and the dual measure (‖∇L‖ inner /
# stationarity outer) — the same three the IPOPT path plots.
#
# Numbering is SEQUENTIAL over rows, not read out of the iter column: that column
# is "·" for every inner step and only becomes an integer on the last outer
# iteration, so trusting it yields a single point at the end (verified: a 5-outer
# run printed 1 integer row and ~200 "·" rows). Each inner row is one optimizer
# step, so counting rows gives the dense curve IPOPT streams locally.
const ALT_ROW = r"^\s*(?:·|\d+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s"
alt_cb_fired = Ref(false)

# WHICH channel carries this run, decided BEFORE the solve starts.
#
# Deciding reactively — stand the bridge down once alt_cb first fires — is a race,
# and it loses. alt_cb fires at the END of an outer iteration, so by then the
# bridge has already translated every inner row of outer #1 under its own
# numbering. Observed on Piccolissimo 0.3.1: the curve climbed to 51 (bridge,
# counting inner rows) then reset to 1 (callback, counting outer iterations) —
# 51 → 1 → 1 → 2 → 2 …, which the Inspector plots as a sawtooth and which reads
# as a diverging solve.
#
# The two scales are irreconcilable (dense inner steps vs sparse outer
# iterations), so exactly ONE channel may emit. Prefer the callback wherever it is
# forwarded: it carries pulse frames as well as numbers, which the table cannot.
#
# A version gate, because forwarding is not introspectable: Piccolissimo 0.3.x
# passes `callback` into Altissimo.optimize!; 0.2.x drops it via a hardcoded kwarg
# whitelist. alt_cb_fired stays as a belt — if a backport forwards it on an older
# version, the bridge still stands down once the callback proves itself.
const CB_FORWARDED = try
    pkgversion(Piccolissimo) >= v"0.3.0"
catch
    false
end

"""Run the Altissimo solve, mirroring its verbose table into AMICODE_ITER lines.

Writes through to the ORIGINAL stdout and appends run.log directly instead of
calling `emit()`: stdout is redirected for the duration of the solve, so emit()
would feed the very pipe this reader is draining."""
function solve_altissimo_streaming(qcp, opts, cb)
    real_out = stdout
    pipe = Pipe()
    Base.link_pipe!(pipe; reader_supports_async = true, writer_supports_async = true)
    seq = Ref(0)
    reader = @async begin
        for line in eachline(pipe)
            println(real_out, line)              # the raw table still reaches the log
            flush(real_out)
            # Where the callback IS forwarded it supersedes this bridge: it numbers
            # by outer iteration and carries frames, and two numbering schemes
            # interleaved in one run.log would plot as a sawtooth.
            (CB_FORWARDED || alt_cb_fired[]) && continue
            m = match(ALT_ROW, line)
            m === nothing && continue
            seq[] += 1
            iters[] = seq[]
            out = @sprintf("AMICODE_ITER iter=%d f=%s inf_pr=%s inf_du=%s",
                           seq[], m.captures[1], m.captures[2], m.captures[3])
            println(real_out, out)
            flush(real_out)
            if CLOUD_RUN
                try
                    open("run.log", "a") do io
                        println(io, out)
                    end
                catch   # telemetry must never take down a solve
                end
            end
        end
    end
    try
        redirect_stdout(pipe) do
            solve!(qcp; options = opts, callback = cb)
        end
    finally
        close(pipe.in)
        try
            wait(reader)
        catch
        end
        close(pipe)
    end
    # Say which channel carried the run — the two produce different iteration
    # SCALES (outer iterations vs inner steps), so a reader comparing two runs
    # needs to know which they are looking at.
    if alt_cb_fired[]
        emit("AMICODE_NOTE Altissimo telemetry came from the solver callback " *
             "(Piccolissimo $(pkgversion(Piccolissimo)) forwards it): iterations count OUTER " *
             "iterations, and per-iteration pulse frames are available")
    else
        emit("AMICODE_NOTE Piccolissimo $(pkgversion(Piccolissimo)) does not forward `callback` to " *
             "Altissimo, so iterations were read from the solver's own table ($(seq[]) rows, one per " *
             "INNER step) and per-iteration pulse frames are unavailable; the final pulse is still written")
    end
end

# Fingerprint the stack this run actually used. A cloud run executes against the
# runner's BAKED bundle, not the caller's environment, so "which Piccolissimo was
# that?" is otherwise unanswerable after the fact — and it is the first question
# every cloud failure raises. Emitted before the solve so it survives a solve that
# dies. Also records whether the callback channel is live, since the two channels
# count different things (outer iterations vs inner steps).
emit("AMICODE_ENV piccolo=$(pkgversion(Piccolo)) " *
     (SOLVER === :altissimo ?
        "piccolissimo=$(pkgversion(Piccolissimo)) dto=$(pkgversion(DirectTrajOpt)) " *
        "callback_forwarded=$(CB_FORWARDED) " : "") *
     "julia=$(VERSION) solver=$(SOLVER)")

# Any exception from here on is reported INTO run.log before it propagates.
#
# On a cloud run the exception is otherwise invisible: julia's stderr goes to the
# SSM command stream, which no API exposes, so the user gets `failed, exit 1` and
# nothing else — that is exactly what happened to task 582a, which reached
# AMICODE_PULSE_META and then died with no recoverable reason. emit() writes
# run.log, which the sidecar syncs and the poller greps, so this makes the next
# failure self-diagnosing without waiting on an infra change.
#
# Rethrown, not swallowed: the run must still FAIL. A solve that reports success
# after an exception is the silent-no-op class of bug this template already guards
# against elsewhere.
function report_and_rethrow(e, bt)
    try
        emit("AMICODE_ERROR $(sprint(showerror, e))")
        for frame in first(stacktrace(bt), 12)
            emit("AMICODE_ERROR   at $(frame)")
        end
    catch
        # never let the reporter mask the original failure
    end
    rethrow(e)
end

t0 = time()
try
    if SOLVER === :altissimo
    # The budget goes on the OPTIONS, not as a solve! kwarg. solve!(::AltissimoOptions)
    # forwards a hardcoded list to Altissimo.optimize! and swallows the rest, so a
    # `max_iter =` here is silently dropped and the solve quietly runs Altissimo's
    # default 20 outer iterations instead of the FILL-IN value.
    #
    # verbose = true is load-bearing, not chatter: it is what makes the iteration
    # table — and therefore the stdout telemetry bridge above — exist at all.
    solve_altissimo_streaming(
        qcp,
        Piccolissimo.AltissimoOptions(max_outer_iter = max_iter, verbose = true),
        alt_cb,
    )
else
    solve!(qcp; max_iter = max_iter, print_level = 1,
           options = IpoptOptions(intermediate_callback = pulse_emit),
           callback = CB.callback_factory(cb_log))
end
catch e
    report_and_rethrow(e, catch_backtrace())
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

# A solve that recorded ZERO iterations did not optimize anything — the fidelity
# above is the random initial guess. Say so instead of letting FINISHED's
# completed/exit-0 read as a converged result downstream. This is the failure that
# hid a silently no-op'd Altissimo backend behind a "converged" badge
# (iterations = 0, fidelity = 0.048, 2026-07-29): the run LOOKED successful, so
# nobody checked. Partial artifacts are still written — the run is recorded, it
# just stops claiming a result it does not have.
if iters[] == 0
    emit("AMICODE_WARN no iterations were recorded — the optimizer never reported progress, so " *
         "fidelity=$(fid) is the INITIAL guess, NOT a converged result (solver=$(SOLVER))")
end
emit("DONE fidelity=$(fid)")
