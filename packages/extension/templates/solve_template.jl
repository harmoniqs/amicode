#!/usr/bin/env julia
# Amicode solve template — fill in the `# FILL IN` block, then:
#   amico-run --project <julia-project> solve.jl
# Emits the run-dir contract (AMICODE_ITER, iter_<N>.png, result.toml, pulse.jld2, DONE).
# Vetted against Piccolo 1.19 (the version `Pkg.add Piccolo` installs today): a
# single-qubit X gate on a 3-level transmon converges to subspace fidelity ~1.0.
using Piccolo
using CairoMakie
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

sys = TransmonSystem(; δ = δ, levels = levels, drive_bounds = fill(drive_max, 2))
op  = size(gate, 1) == sys.levels ? gate : EmbeddedOperator(gate, sys)

times   = collect(range(0.0, T, length = N))
initial = 0.1 * randn(sys.n_drives, N)
qtraj = UnitaryTrajectory(sys, ZeroOrderPulse(initial, times), op)
qcp = SmoothPulseProblem(qtraj, N;
    piccolo_options = PiccoloOptions(timesteps_all_equal = true),
    Q = 100.0, R = 1e-2)
prob = hasproperty(qcp, :prob) ? qcp.prob : qcp

# Per-iter callbacks via Piccolo's PUBLIC `Callbacks` module (Piccolo 1.19).
# NOTE on solver portability: this is the Ipopt intermediate-callback path
# (rich state: obj_value/inf_pr/inf_du). When the default solver moves to
# MadNLP/Altissimo, migrate to the solver-agnostic `AbstractIntermediateCallback`
# (e.g. `LivePulsePlotCallback`), which fires `(primal, iter)` across backends.
const CB = Piccolo.Callbacks

const PLOT_EVERY = 6    # plot every 6 iters (more frequent live frames)
iters = Ref(0)
function cb_log(optimizer, st; kwargs...)
    k = Int(st.iter_count); iters[] = k
    @printf("AMICODE_ITER iter=%d f=%.6e inf_pr=%.3e inf_du=%.3e\n", k, st.obj_value, st.inf_pr, st.inf_du)
    flush(stdout)
    (k > 0 && k % PLOT_EVERY == 0) && save_control_plot(k)   # skip iter-0 (just the random init; defers Makie's first-plot compile off the first iter)
    return true
end

# Per-iter pulse plot via Piccolo's canonical `plot_pulse` (no rollout — keeps
# the live solve fast). `bounds=true` shades the drive bounds; the QCP method
# reads the current optimizer iterate, which callback_update_trajectory_factory
# keeps in sync. Returns a Makie Figure we save as the run-dir frame.
function save_control_plot(k::Int)
    try
        fig = plot_pulse(qcp; bounds = true, title = @sprintf("iter %d", k))
        CairoMakie.save(@sprintf("iter_%04d.png", k), fig)
    catch e
        @warn "iter plot failed" exception = e   # never let plotting kill the solve
    end
end

t0 = time()
solve!(qcp; max_iter = max_iter, print_level = 1,
       callback = CB.callback_factory(CB.callback_update_trajectory_factory(prob), cb_log))
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

# ensure at least one PNG even if the solve stopped before PLOT_EVERY
isfile(@sprintf("iter_%04d.png", iters[])) || save_control_plot(iters[])

JLD2.save("pulse.jld2", "traj", prob.trajectory)   # key "traj" so `load_traj` can reload it (warm-start)
open("result.toml.tmp", "w") do io
    # Record the regime each run actually solved (scalar FILL-IN params), so the
    # result is self-describing — not just fidelity/iterations.
    TOML.print(io, Dict(
        "fidelity" => fid, "iterations" => iters[], "wall_seconds" => wall,
        "params" => Dict("delta" => δ, "levels" => levels, "T" => T, "N" => N,
                         "drive_max" => drive_max, "max_iter" => max_iter),
    ))
end
mv("result.toml.tmp", "result.toml"; force = true)
println("DONE fidelity=$(fid)"); flush(stdout)
