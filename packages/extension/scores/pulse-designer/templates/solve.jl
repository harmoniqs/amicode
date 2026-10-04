#!/usr/bin/env julia
# Amicode solve template — fill in the `# FILL IN` block, then:
#   amico run --project <julia-project> solve.jl
# Emits the run-dir contract (AMICODE_ITER, iter_<N>.png, result.toml, pulse.jld2, DONE).
# Vetted against Piccolo 2.2 / DirectTrajOpt 0.11 / NamedTrajectories 0.9.4 (the
# MadNLP-default release train, #1676): single-qubit family gates (X/Y/Z/H/√X/T) on a
# 3-level transmon converge to subspace fidelity > 0.999 on the linear-spline
# parameterization at R-from-the-grid (the DTO #122 construction), under the
# MadNLP default (the DTO 0.11 flip; QualityFunctionUpdate barrier) at the 60-iter
# audit-safe budget.
using Piccolo
using CairoMakie   # loads PiccoloMakieExt → gives LivePulsePlotCallback its impl
using JLD2
using TOML
using Printf
import MadNLP   # hard dep of DirectTrajOpt ≥ 0.11 — the raw user-callback channel below needs it

# ── version probe (#540, plan step 5; #1676) ─────────────────────────────
# This template REQUIRES Piccolo ≥ 2.2 (DTO ≥ 0.11, NT ≥ 0.9.4): the MadNLP
# default + its hard dep landed with DTO 0.11 (the #155 flip), inherited by
# Piccolo 2.2 (#360). On an older stack it refuses to run — never silently
# misbehaves:
#   - The default arm rides DTO's MadNLP default and a raw
#     `MadNLP.AbstractUserCallback` for the AMICODE_ITER state columns — neither
#     exists pre-0.11 (MadNLP was a lazy package extension and the raw
#     `callback` kwarg was Ipopt-only, Q74).
#   - R below is computed from the grid for the post-DTO-#122 single-Δt
#     QuadraticRegularizer weighting; under the OLD Δt² weighting that R would
#     be 5× under-regularized at the default grid (every non-default grid worse).
#   - The quartet emission rides `Piccolo.shape_metrics`, and the template
#     family's spline-faithful integrator (`SplineIntegrator` — the parked
#     cubic/bend follow-up's dynamics, and the probe's forward guard for it)
#     is a 2.x-only surface.
if !(isdefined(Piccolo, :SplineIntegrator) && isdefined(Piccolo, :shape_metrics) &&
     isdefined(DirectTrajOpt, :MadNLPOptions) && isdefined(DirectTrajOpt, :Solvers) &&
     isdefined(DirectTrajOpt.Solvers, :_get_DefaultSolverOptions) &&
     DirectTrajOpt.Solvers._get_DefaultSolverOptions() === DirectTrajOpt.MadNLPOptions)
    error(
        "Amicode vetted template requires Piccolo ≥ 2.2 (DirectTrajOpt ≥ 0.11 — the " *
        "MadNLP-default flip; NamedTrajectories ≥ 0.9.4); this environment has an older " *
        "stack. The default arm rides the DTO MadNLP default + its raw user callback " *
        "(the AMICODE_ITER state columns); a pre-0.11 DTO has neither (the raw `callback` " *
        "kwarg was Ipopt-only, Q74). Point --project at the provisioned env (the " *
        "MadNLP-default release train, #1676).",
    )
end

# ── FILL IN ──────────────────────────────────────────────────────────────
δ          = 0.2        # anharmonicity (GHz, positive convention)
levels     = 3          # transmon levels modeled (3 = qubit + 1 leakage; bump to 4–5 for more leakage realism)
gate       = GATES[:X]
T          = 10.0       # gate time (ns)
N          = 50         # timesteps
drive_max  = 0.2        # per-quadrature drive bound (GHz)
max_iter   = 60         # audit-safe under the MadNLP default (the DTO #155 restoration audit)
SOLVER     = :default   # :default (MadNLP — the DTO 0.11 default), :ipopt, or :altissimo (High-Performance + Cloud)
# ─────────────────────────────────────────────────────────────────────────

SOLVER in (:default, :ipopt, :altissimo) || error("SOLVER must be :default (MadNLP), :ipopt, or :altissimo, got $SOLVER")
if SOLVER === :altissimo
    @eval using Piccolissimo   # AltissimoOptions lives here, not in Piccolo
end

# ── R FROM THE GRID (#540, plan step 2 — DTO #122) ────────────────────────
# DTO #122 changed QuadraticRegularizer weighting from Δt² to a single Δt:
#   old: J = Σₜ ½ · Δt² · Δvᵀ R Δv        new: J = Σₜ ½ · Δt · Δvᵀ R Δv
# The shipped 1.19/0.9.7 template's R = 1e-2 (Δt² weighting) is reproduced on
# the new semantics by R_new = R_old · Δt on a uniform grid. So R is COMPUTED
# from the FILL-IN values — exact at every Δt, never a hard-coded constant (a
# frozen 2e-3 would silently mis-compensate every non-default T/N solve).
R = 1e-2 * (T / N)   # = R_old · Δt; 1e-2 · (10/50) = 2e-3 on the default grid

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
# Why gated on a cloud run: LOCALLY `amico run`'s executor already writes run.log
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
# ── the parameterization (F1 fallback, #540) ───────────────────────────────
# LINEAR spline at R-from-the-grid — semantics-equivalent to the shipped
# 1.19/0.9.7 behavior by the DTO #122 construction (see R above): the linear
# SplinePulseProblem resolves R_u = R_du = R on this family, the du variables are
# constrained to the inter-knot slopes (DerivativeIntegrator), and the dynamics
# run on the SAME PWC (BilinearIntegrator) collocation the shipped SmoothPulse
# problem used — the #275 guard's acknowledged `integrator_type = :pwc` path
# (the near-isomorphic NLP: u + constrained slopes + R-regularized, PWC
# propagation). The rollout below measures the linear waveform of the shipped
# pulse artifact, exactly as the shipped template's rollout did.
#
# The cubic/bend parameterization move (CubicSplinePulse + R_bend riding
# Piccolo #312's landed default) MISSED the family bar on our template —
# X at F = 0.7918 in 60 iterations (run r20260901-191606Z-5393, still mid-descent
# with inf_du = 1.6 at max_iter) — and is parked as a named follow-up (F1: a miss
# reverts, it does not retune). A first fallback attempt with the
# spline-faithful SplineIntegrator (linear family) ALSO missed — X at
# F = 0.9974 (run r20260901-191807Z-9f22), monotone descent but a slower NLP
# class than the shipped Bilinear collocation — so the fallback uses the
# equivalence-faithful PWC dynamics the spec's "semantics-equivalent to the
# shipped behavior" construction names. No parameter retuned anywhere
# (max_iter/N/R/Q at the FILL-IN defaults throughout).
pulse = LinearSplinePulse(initial, times)
qtraj = UnitaryTrajectory(sys, pulse, op)
qcp = SplinePulseProblem(qtraj, N;
    Q = 100.0, R = R,
    integrator_type = :pwc,
    piccolo_options = PiccoloOptions(timesteps_all_equal = true))
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
    # run dir (== cwd). Returning false from the intermediate callback halts the
    # solve (User_Requested_Stop) at the next iteration; solve! returns
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

# AMICODE_ITER — the rich-state text telemetry (f/inf_pr/inf_du per iteration).
# Both backend arms carry it, through backend-native channels: the solver-agnostic
# `(primal, iter)` contract cannot carry the IPM state columns the Inspector's
# stats row reads (Q74 amended — no longer "ipopt-only"; the channel moved, not
# the requirement):
#   - IPOPT (selectable): the RAW Ipopt callback via `callback =
#     CB.callback_factory(cb_log)` — DTO composes the raw channel with
#     `intermediate_callback`, both firing once per IPM iteration (the factory's
#     home is DirectTrajOpt.Callbacks since DTO 0.10; Piccolo no longer re-homes it).
#   - MADNLP (the default since DTO 0.11): the raw `callback` kwarg is DEAD on
#     the MadNLP arm — emission rides `intermediate_callback` as a raw
#     `MadNLP.AbstractUserCallback`, and restore/robust phases fire that
#     callback WITHOUT advancing the iteration counter, so the emitter filters
#     on `UserCallbackRegular` (mirrors DTO's own `_MadNLPCallbackAdapter` and
#     Piccolo 2.2's specs/run.jl — the emitted iters stay monotone).
const CB = DirectTrajOpt.Callbacks
iters = Ref(0)
function cb_log(optimizer, st; kwargs...)
    k = Int(st.iter_count); iters[] = k
    emit(@sprintf("AMICODE_ITER iter=%d f=%.6e inf_pr=%.3e inf_du=%.3e", k, st.obj_value, st.inf_pr, st.inf_du))
    return true
end

# The MadNLP arm's ONE channel carries BOTH: it delegates to pulse_emit first
# (frames + AMICODE_PULSE + the cooperative STOP — the same solver-agnostic
# `(primal, iter)` contract; `MadNLP.variable(solver.x)` strips the slack tail
# and hands back the full NLP primal), then emits the AMICODE_ITER line from
# MadNLP's own state accessors. A raw user callback manages its own
# fixed-variable treatment: pulse_emit maps the primal back onto the trajectory,
# which needs the fixed (lb==ub) variables present in solver.x — hence the
# explicit `fixed_variable_treatment = MadNLP.RelaxBound` on the solve call
# below (DTO auto-couples that only for AbstractIntermediateCallback installs).
struct IterEmitCallbackMadNLP <: MadNLP.AbstractUserCallback
    inner::Any   # pulse_emit — frames + AMICODE_PULSE + cooperative STOP
end
function (cb::IterEmitCallbackMadNLP)(solver, mode)
    mode isa MadNLP.UserCallbackRegular || return true   # main IPM loop only
    k = Int(MadNLP.get_cnt(solver).k)
    ok = cb.inner(MadNLP.variable(solver.x), k)
    iters[] = max(iters[], k)
    emit(@sprintf("AMICODE_ITER iter=%d f=%.6e inf_pr=%.3e inf_du=%.3e", k,
                  MadNLP.get_obj_val(solver), MadNLP.get_inf_pr(solver), MadNLP.get_inf_du(solver)))
    return ok
end

# Altissimo carries no `intermediate_callback` — its only per-iteration hook is
# the `callback` kwarg on `Altissimo.optimize!`, which Piccolissimo forwards from
# `solve!(::AltissimoOptions)`, and it arrives as `(x, info)` rather than
# `(optimizer, IpoptOptimizerState)`. So BOTH channels have to be re-hung here:
# without this the frames stop too (they come off the backend's
# `intermediate_callback`), and an Altissimo solve leaves the Run Inspector
# completely dark rather than merely numberless.
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
    # The budget goes on the OPTIONS, not as a solve! kwarg. solve!(::AltissimoOptions)
    # forwards a hardcoded list to Altissimo.optimize! and swallows the rest, so a
    # `max_iter =` here is silently dropped and the solve quietly runs Altissimo's
    # default 20 outer iterations instead of the FILL-IN value.
    solve!(qcp; options = Piccolissimo.AltissimoOptions(max_outer_iter = max_iter), callback = alt_cb)
elseif SOLVER === :ipopt
    # The documented selectable Ipopt path (unchanged construction): the raw
    # `callback` channel is Ipopt-only there — DTO composes it with
    # `intermediate_callback`, both firing once per IPM iteration.
    solve!(qcp; max_iter = max_iter, print_level = 1,
           options = IpoptOptions(intermediate_callback = pulse_emit),
           callback = CB.callback_factory(cb_log))
else
    # The default arm rides DTO's own default — MadNLP since 0.11 (#155,
    # inherited by Piccolo 2.2) — with no options struct named: the kwargs land
    # on the default MadNLPOptions fields. print_level 0 = MadNLP ERROR (the
    # Ipopt-scale silence idiom carries through the flip; 1 is quiet on the
    # Ipopt arm but TRACE-loud on MadNLP's reversed 1=TRACE…6=ERROR scale).
    # Budget: 60 — audit-safe under the QualityFunctionUpdate barrier default
    # (the DTO #155 restoration audit: 0.99999996 @ 60 on the previously-failing
    # seed class, zero restore/robust events across the audited matrix).
    solve!(qcp; max_iter = max_iter, print_level = 0,
           intermediate_callback = IterEmitCallbackMadNLP(pulse_emit),
           fixed_variable_treatment = MadNLP.RelaxBound)
end
wall = time() - t0

# Fidelity over the COMPUTATIONAL subspace, from a fresh high-tolerance rollout.
# Three reasons this is the right metric:
#   - subspace (not full-space): the embedded goal pins identity on the leakage
#     level, which the solve doesn't enforce — full-space would read ~0.44 even
#     for a perfect qubit gate. We want the gate fidelity on {|0>,|1>}.
#   - rollout (not the raw final propagator): re-integrating at 1e-8 yields a
#     clean unitary, avoiding the ~1e-6 norm-drift that made the raw block read >1.
#   - linear interpolation: the rollout integrates the SAME linear waveform
#     the SplineIntegrator constrains (order-1 spline) — the pairing the #275
#     guard exists to keep honest. A :constant rollout would measure a
#     different waveform than the one the optimizer scored.
Uroll = iso_vec_to_operator(unitary_rollout(get_trajectory(qcp), sys;
        state_name = state_name(qtraj), interpolation = :linear)[:, end])
fid   = unitary_fidelity(Uroll, op.operator; subspace = op.subspace)

# ── the shape quartet (SEAM 3, #540 plan step 4) ───────────────────────────
# Piccolo.shape_metrics over the SOLVED pulse: bend (∫|u″|²dt — the transfer
# predictor; C¹-families-only comparable — on the linear spline it is carried
# but meaningful within-parameterization only), int_u2 (the Bloch–Siegert
# proxy), max_du (intra-span slew), crest (hardware ACDR check, never a
# selection rule). Feature-gated by the SAME 2.x probe as the version gate
# (a pre-2.x env skips the emission — never errors) and try/catch-wrapped so
# the emission can never break the run.
# Emitted under `params.shape_metrics` — the run-dir result schema pins its
# top level closed (additionalProperties: false) and the Inspector's
# readTerminalState drops fidelity on a schema-invalid result.toml, while
# `params` is lenient by design: the quartet rides the self-describing params
# section, additive, zero field loss for any consumer.
# `let` (a hard scope): at top level a bare `if`/`try` reassignment of a global
# is soft-scope-ambiguous — the first micro-run silently dropped the quartet
# that way (local `shape_quartet` shadowed the global, params carried nothing).
shape_quartet = let result = nothing
    if isdefined(Piccolo, :shape_metrics)
        try
            sm = Piccolo.shape_metrics(extract_pulse(qtraj, prob.trajectory); mesh = 2^16)
            result = Dict{String,Any}(
                "bend" => collect(sm.bend),
                "int_u2" => collect(sm.int_u2),
                "max_du" => collect(sm.max_du),
                "crest" => collect(sm.crest),
                "T" => sm.T,
                "parameterization" => sm.parameterization,
            )
        catch e
            @warn "shape_metrics emission failed" exception = e maxlog = 3
        end
    end
    result
end

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
    params = Dict{String,Any}("delta" => δ, "levels" => levels, "T" => T, "N" => N,
                              "drive_max" => drive_max, "max_iter" => max_iter)
    if shape_quartet !== nothing
        params["shape_metrics"] = shape_quartet
    end
    TOML.print(io, Dict(
        "schema_version" => "1",   # run-dir contract version (@amicode/schema result schema)
        "fidelity" => fid, "iterations" => iters[], "wall_seconds" => wall,
        "params" => params,
    ))
end
mv("result.toml.tmp", "result.toml"; force = true)
emit("DONE fidelity=$(fid)")
