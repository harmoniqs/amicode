#!/usr/bin/env julia
# Amicode solve template — fill in the `# FILL IN` block, then:
#   amico-run --project <julia-project> solve.jl
# Emits the run-dir contract (AMICODE_ITER, iter_<N>.png, result.toml, pulse.jld2, DONE).
# Vetted against Piccolo 0.11 (QuantumCollocation/DirectTrajOpt 0.8): a single-qubit
# X gate on a 3-level transmon converges to subspace fidelity ~1.0 in ~1 min.
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
dto_prob = hasproperty(qcp, :prob) ? qcp.prob : qcp

# Per-iter callback machinery lives in DirectTrajOpt's internal IpoptSolverExt
# (not re-exported); reach it through the solve! method table (β.1 pattern).
const Callbacks = first(filter(
    m -> string(m.module) == "DirectTrajOpt.IpoptSolverExt",
    collect(methods(solve!)))).module.Callbacks

const PLOT_EVERY = 10
iters = Ref(0)
cb_update = Callbacks.callback_update_trajectory_factory(dto_prob)
function cb_log(optimizer, st; kwargs...)
    k = Int(st.iter_count); iters[] = k
    @printf("AMICODE_ITER iter=%d f=%.6e inf_pr=%.3e inf_du=%.3e\n", k, st.obj_value, st.inf_pr, st.inf_du)
    flush(stdout)
    if k % PLOT_EVERY == 0
        save_control_plot(k)
    end
    return true
end

# Cheap per-iter plot: control amplitudes vs time (no rollout — keeps the
# live solve fast). `cb_update` has refreshed dto_prob.trajectory by now.
function save_control_plot(k::Int)
    try
        u = dto_prob.trajectory[:u]            # (n_drives × N) control amplitudes
        fig = Figure(size = (640, 360))
        ax = Axis(fig[1, 1], xlabel = "timestep", ylabel = "drive amplitude (GHz)",
                  title = @sprintf("iter %d", k))
        for d in 1:size(u, 1)
            lines!(ax, 1:size(u, 2), vec(u[d, :]), label = "u$(d)")
        end
        axislegend(ax; position = :rt)
        CairoMakie.save(@sprintf("iter_%04d.png", k), fig)
    catch e
        @warn "iter plot failed" exception = e   # never let plotting kill the solve
    end
end

t0 = time()
solve!(qcp; max_iter = max_iter, print_level = 1,
       callback = Callbacks.callback_factory(cb_update, cb_log))
wall = time() - t0

# Fidelity over the COMPUTATIONAL subspace (full-space fidelity is misleading
# for an embedded gate — it includes leakage levels + global phase).
Ufin = iso_vec_to_operator(get_trajectory(qcp)[:Ũ⃗][:, end])
fid  = unitary_fidelity(Ufin, op.operator; subspace = op.subspace)

# ensure at least one PNG even if the solve stopped before PLOT_EVERY
isfile(@sprintf("iter_%04d.png", iters[])) || save_control_plot(iters[])

JLD2.save("pulse.jld2", "trajectory", dto_prob.trajectory)
open("result.toml.tmp", "w") do io
    TOML.print(io, Dict("fidelity" => fid, "iterations" => iters[], "wall_seconds" => wall))
end
mv("result.toml.tmp", "result.toml"; force = true)
println("DONE fidelity=$(fid)"); flush(stdout)
