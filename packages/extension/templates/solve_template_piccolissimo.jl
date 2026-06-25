#!/usr/bin/env julia
# Amicode solve template — PICCOLISSIMO variant.
#
# Single-qubit transmon X gate, solved with Piccolissimo's exact-propagation
# `HermitianExponentialIntegrator`. This is the amicode-beta target (we move the
# stack onto Piccolissimo), held parallel to `solve_template.jl` until the
# Piccolissimo binary is consumable — see PICCOLISSIMO_INTEGRATION.md.
#
# Verified end-to-end through amico-run against a local Piccolissimo checkout
# (Piccolo 1.10 + Piccolissimo + CairoMakie, julia 1.12.3): X gate on a 3-level
# transmon converges to subspace fidelity F = 0.99995 in 60 iters (~88s cold).
#
# Two things differ from the raw-Piccolo template:
#   1. Piccolissimo does NOT reexport Piccolo → load BOTH.
#   2. The exact `HermitianExponentialIntegrator` replaces the default integrator.
# Everything else (run-dir contract, plot_pulse frames) is identical.
using Piccolo
using Piccolissimo
using CairoMakie
using JLD2
using TOML
using Printf

# ── FILL IN ──────────────────────────────────────────────────────────────
δ          = 0.2        # anharmonicity (GHz, positive convention)
levels     = 3          # transmon levels (3 = qubit + 1 leakage; 4 for more realism)
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

# Piccolissimo's exact propagator: eigendecomposition + analytic Jacobians.
integrator = HermitianExponentialIntegrator(qtraj, N)
qcp = SmoothPulseProblem(qtraj, N; integrator = integrator,
    # Fix the timesteps. With a free Δt the dual infeasibility oscillates and the
    # solve stalls at F≈0.976; pinning it converges to F≈0.99995. (Same lesson as
    # the raw-Piccolo template — don't drop this when swapping the integrator.)
    piccolo_options = PiccoloOptions(timesteps_all_equal = true),
    Q = 100.0, R = 1e-2)
prob = hasproperty(qcp, :prob) ? qcp.prob : qcp

# Per-iter callbacks via Piccolo's public `Callbacks` module.
const CB = Piccolo.Callbacks
const PLOT_EVERY = 6    # plot every 6 iters (live frames for the inspector)
iters = Ref(0)
function cb_log(optimizer, st; kwargs...)
    k = Int(st.iter_count); iters[] = k
    @printf("AMICODE_ITER iter=%d f=%.6e inf_pr=%.3e inf_du=%.3e\n", k, st.obj_value, st.inf_pr, st.inf_du)
    flush(stdout)
    (k > 0 && k % PLOT_EVERY == 0) && save_control_plot(k)   # skip iter-0 (random init; defers Makie's first compile)
    return true
end

# Per-iter pulse plot via Piccolo's canonical `plot_pulse` (Makie). Returns a
# Figure we save as the run-dir frame. NOTE: Piccolissimo's deps do not include
# CairoMakie, so under a Piccolissimo pkgimage this first call still JIT-compiles
# Makie (~35s) unless CairoMakie is baked into the image — see the integration doc.
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

# Subspace fidelity from a fresh rollout (see solve_template.jl for the rationale).
Uroll = iso_vec_to_operator(unitary_rollout(get_trajectory(qcp), sys)[:, end])
fid   = unitary_fidelity(Uroll, op.operator; subspace = op.subspace)

isfile(@sprintf("iter_%04d.png", iters[])) || save_control_plot(iters[])

JLD2.save("pulse.jld2", "traj", prob.trajectory)   # key "traj" for load_traj (warm-start)
open("result.toml.tmp", "w") do io
    TOML.print(io, Dict(
        "fidelity" => fid, "iterations" => iters[], "wall_seconds" => wall,
        "params" => Dict("delta" => δ, "levels" => levels, "T" => T, "N" => N,
                         "drive_max" => drive_max, "max_iter" => max_iter),
    ))
end
mv("result.toml.tmp", "result.toml"; force = true)
println("DONE fidelity=$(fid)"); flush(stdout)
