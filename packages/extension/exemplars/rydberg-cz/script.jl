#!/usr/bin/env julia
# ⚠️ EXPERIMENTAL — NOT YET VETTED. The NLP's first iteration is pathologically
# slow at this problem size in the current Piccolo path (both closure- and
# matrix-form systems tried; single iteration > 25 min where the transmon
# template solves in 72 s). Under investigation — do not wire into scores or
# demos until a vetting solve completes with F > 0.99.
#
# Amicode Rydberg CZ template — fill in the `# FILL IN` block, then:
#   amico-run --project <julia-project> solve.jl
# Emits the run-dir contract (AMICODE_ITER, iter_<N>.png, result.toml, pulse.jld2, DONE).
#
# Physics: two neutral atoms, 3 levels each (|0⟩ dark, laser couples |1⟩↔|r⟩,
# van-der-Waals blockade V·n⊗n on |rr⟩). CZ is the NATIVE entangling gate —
# defined on the {|0⟩,|1⟩}⊗2 computational subspace via EmbeddedOperator, and
# optimized with free_phase=true (CZ up to virtual single-atom Z rotations;
# fixed-phase fidelity systematically underreports entangling gates — both are
# recorded in result.toml, free-phase is the primary metric).
# Defaults = QuEra gate-zone (⁸⁷Rb, deep blockade, d = 2 μm). Units: μs, rad/μs.
using Piccolo
using CairoMakie   # loads PiccoloMakieExt → gives LivePulsePlotCallback its impl
using JLD2
using LinearAlgebra   # Diagonal (free-phase goal construction)
using TOML
using Printf

# ── FILL IN ──────────────────────────────────────────────────────────────
Ω_max      = 4.6 * 2π     # global Rabi bound (rad/μs) — QuEra gate zone
Δ_max      = 20.0 * 2π    # global detuning bound (rad/μs)
C6         = 28_800.0 * 2π # van der Waals coefficient (rad/μs·μm⁶)
distance   = 2.0          # atom spacing (μm) → V = C6/d⁶ (deep blockade: V/Ω ≈ 98)
T          = 0.5          # gate time (μs) — J&P speed limit ≈ 7.61/Ω_max ≈ 0.26 μs; fixed-phase needs extra slack
N          = 51           # timesteps
max_iter   = 400
# ─────────────────────────────────────────────────────────────────────────

V = C6 / distance^6

# Single-atom 3-level operators: basis |0⟩=1, |1⟩=2, |r⟩=3 (|0⟩ is dark).
const σx_1r = ComplexF64[0 0 0; 0 0 1; 0 1 0]                # |1⟩⟨r| + h.c.
const σy_1r = ComplexF64[0 0 0; 0 0 -im; 0 im 0]             # -i|1⟩⟨r| + i|r⟩⟨1|
const n_r   = ComplexF64[0 0 0; 0 0 0; 0 0 1]                # |r⟩⟨r|
const I3    = ComplexF64[1 0 0; 0 1 0; 0 0 1]

# Two atoms, global drives (QuEra zoned architecture: no individual addressing).
Hx = kron(σx_1r, I3) + kron(I3, σx_1r)     # u[1] = Ωx(t)
Hy = kron(σy_1r, I3) + kron(I3, σy_1r)     # u[2] = Ωy(t)
Hn = kron(n_r, I3) + kron(I3, n_r)         # u[3] = -Δ(t) (sign folded into H below)
H_drift = V * kron(n_r, n_r)               # blockade shift on |rr⟩

# Matrix form (NOT a closure): hands Piccolo the bilinear structure analytically —
# the function-Hamiltonian path forces AD through the closure per NLP evaluation
# and is orders of magnitude slower at 9-dim. Detuning sign folded into the drive.
sys = QuantumSystem(H_drift, [Hx, Hy, -Hn],
    [(-Ω_max, Ω_max), (-Ω_max, Ω_max), (-Δ_max, Δ_max)])

# CZ on the {|0⟩,|1⟩} subspace of each atom, embedded in the 9-dim space.
op = EmbeddedOperator(GATES[:CZ], [1, 2], [1:2, 1:2], [3, 3])

times   = collect(range(0.0, T, length = N))
initial = 0.1 * randn(sys.n_drives, N)
qtraj = UnitaryTrajectory(sys, ZeroOrderPulse(initial, times), op)
# NOTE: free_phase=true needs Piccolissimo's global-aware integrator — this
# template stays public-Piccolo-only (the lab project ships Piccolo). So the
# NLP targets FIXED-phase CZ (the detuning drive supplies the authority to null
# the single-atom phases), and the free-phase metric is recovered at report
# time by a virtual-Z scan over the rolled-out unitary (phases are software
# rotations; best-phase fidelity is the honest primary metric).
qcp = SmoothPulseProblem(qtraj, N;
    piccolo_options = PiccoloOptions(timesteps_all_equal = true),
    Q = 100.0, R = 1e-2)
prob = hasproperty(qcp, :prob) ? qcp.prob : qcp

# Per-iter live plot — same blessed idiom as the transmon template (AGENTS.md):
# LivePulsePlotCallback writes iter_<N>.png; the Run Inspector reads the frames.
const PLOT_EVERY = 6
live_plot = LivePulsePlotCallback(qtraj, prob.trajectory; every = PLOT_EVERY, save_dir = ".")

# Pulse-data telemetry (#66): AMICODE_PULSE lines per iteration, riding the same
# solver-agnostic (primal, iter) hook as the live plot. Verbatim from the vetted
# transmon template — the contract is identical.
struct PulseEmitCallback <: AbstractIntermediateCallback
    inner::Any
    traj::Any
end
function (cb::PulseEmitCallback)(primal, iter)
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

let ls = "\"Ωx\",\"Ωy\",\"Δ\"",
    bs = "$(-Ω_max):$(Ω_max),$(-Ω_max):$(Ω_max),$(-Δ_max):$(Δ_max)"
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
solve!(qcp; max_iter = max_iter, print_level = 1,
       options = IpoptOptions(intermediate_callback = pulse_emit),
       callback = CB.callback_factory(cb_log))
wall = time() - t0

# Fidelity on the computational subspace from a fresh rollout (same rationale as
# the transmon template), reported BOTH ways:
#   fixed-phase — raw CZ target;
#   free-phase  — CZ up to the optimized virtual Z's (φ_1, φ_2) — PRIMARY metric.
traj_final = get_trajectory(qcp)
Uroll = iso_vec_to_operator(unitary_rollout(traj_final, sys)[:, end])
fid_fixed = unitary_fidelity(Uroll, op.operator; subspace = op.subspace)

# Free-phase metric via post-hoc virtual-Z scan: CZ is equivalent up to
# single-atom Z rotations exp(i(φ₁n₁+φ₂n₂)); scan (φ₁,φ₂), then refine. The
# basis phase per computational state |b₁b₂⟩ is φ₁b₁+φ₂b₂ (the
# _make_free_phase_goal convention).
phase_fid(φ1, φ2) = unitary_fidelity(Uroll,
    Diagonal(ComplexF64[1, exp(im * φ2), exp(im * φ1), exp(im * (φ1 + φ2))]) * GATES[:CZ];
    subspace = op.subspace)
best_f, best_φ1, best_φ2 = fid_fixed, 0.0, 0.0
for φ1 in range(0, 2π; length = 73), φ2 in range(0, 2π; length = 73)
    f = phase_fid(φ1, φ2)
    if f > best_f
        best_f, best_φ1, best_φ2 = f, φ1, φ2
    end
end
for δφ in (0.02, 0.002)   # two local refinement passes around the grid optimum
    for φ1 in range(best_φ1 - 5δφ, best_φ1 + 5δφ; length = 11),
        φ2 in range(best_φ2 - 5δφ, best_φ2 + 5δφ; length = 11)
        f = phase_fid(φ1, φ2)
        if f > best_f
            best_f, best_φ1, best_φ2 = f, φ1, φ2
        end
    end
end
fid_free = best_f
phases = [best_φ1, best_φ2]
fid = max(fid_free, fid_fixed)

let final_cb = LivePulsePlotCallback(qtraj, prob.trajectory; every = 1, save_dir = ".")
    tr = prob.trajectory
    final_primal = tr.global_dim > 0 ? vcat(collect(tr.datavec), collect(tr.global_data)) : collect(tr.datavec)
    final_cb(final_primal, iters[])
end

JLD2.save("pulse.jld2", "traj", traj_final)
open("result.toml.tmp", "w") do io
    TOML.print(io, Dict(
        "schema_version" => "1",
        "fidelity" => fid, "iterations" => iters[], "wall_seconds" => wall,
        "params" => Dict("platform" => "rydberg", "gate" => "CZ",
                         "Omega_max" => Ω_max, "Delta_max" => Δ_max,
                         "C6" => C6, "distance" => distance,
                         "V_blockade" => V, "T" => T, "N" => N, "max_iter" => max_iter,
                         "fidelity_fixed_phase" => fid_fixed,
                         "fidelity_free_phase" => fid_free,
                         "phi_1" => length(phases) == 2 ? phases[1] : 0.0,
                         "phi_2" => length(phases) == 2 ? phases[2] : 0.0),
    ))
end
mv("result.toml.tmp", "result.toml"; force = true)
println("DONE fidelity=$(fid)"); flush(stdout)
