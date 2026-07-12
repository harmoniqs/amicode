#!/usr/bin/env julia
# Amicode pasqal-mis solve template — fill in the `# FILL IN` block, then:
#   amico-run --project <julia-project> solve.jl
# Emits the run-dir contract (AMICODE_ITER, iter_<N>.png, result.toml, pulse.jld2, DONE)
# plus `waveforms.json` — the seam templates/register.py (Pulser) reads.
#
# Physics: global-drive Rydberg MIS. Each vertex is an atom; the blockade makes the
# Maximum Independent Set the ground state of the final Hamiltonian
#   H(t)/ħ = (Ω(t)/2) Σᵢ σₓⁱ − δ(t) Σᵢ nᵢ + Σᵢ<ⱼ (C₆/rᵢⱼ⁶) nᵢnⱼ .
# We optimize the two GLOBAL waveforms (Ω, δ), warm-started from the textbook
# adiabatic ramp, to maximize the probability of measuring the MIS bitstring.
# Pure public Piccolo (1.19); the MIS target is brute-forced classically, so the
# validation is airtight for these instance sizes.
using Piccolo
using CairoMakie   # loads PiccoloMakieExt → gives LivePulsePlotCallback its impl
using JLD2
using TOML
using Printf
using LinearAlgebra
using SparseArrays
BLAS.set_num_threads(1)   # avoid OpenBLAS × Julia-thread oversubscription (/solve rule)

# ── FILL IN ──────────────────────────────────────────────────────────────
# Atom positions (μm). Default: 4-atom star — center + 3 leaves at 9 μm; the
# unique MIS is the three leaves. Replace with your register's positions.
# Scale discipline: the transcription integrates H·Δt per step, so keep
# max ‖H‖ · (T/N) ≲ 0.2 — that is why the demo softens the blockade (9 μm →
# U ≈ 10 rad/μs) and uses N = 100 over T = 2 μs. If you raise the energy
# scales or atom count, raise N with them — the verification step below will
# tell you when the transcription lied.
positions  = [(0.0, 0.0), (0.0, 9.0), (-7.794, -4.5), (7.794, -4.5)]
C6         = 5.42e6     # rad·μm⁶/μs (Rb 60S-ish; Pasqal AnalogDevice scale)
R_blockade = 10.0       # μm — pairs closer than this are graph edges
Ω_max      = 6.3        # rad/μs global Rabi bound (Ω ≥ 0) ≈ 2π × 1 MHz
δ_bounds   = (-8.0, 6.0)  # rad/μs detuning channel bounds (final δ must sit below the edge blockade U ≈ 10)
T          = 6.0        # sweep duration (μs) — the blockade gap (~5 rad/μs) wants a gentle sweep; 2 μs verifiably caps P(MIS) ≈ 0.4
N          = 300        # timesteps → Δt = 0.02 μs (transcription accuracy — see scale discipline above)
max_iter   = 100
# ─────────────────────────────────────────────────────────────────────────

n = length(positions)
@assert n <= 12 "local solves cap at 12 atoms (dim 2^n) — larger graphs want the cloud solver"

dist(i, j)  = hypot(positions[i][1] - positions[j][1], positions[i][2] - positions[j][2])
edges       = [(i, j) for i in 1:n for j in (i+1):n if dist(i, j) < R_blockade]

# Classical ground truth: brute-force the MIS of the unit-disk graph (2^n, n ≤ 12).
is_indep(b) = all(((i, j),) -> (b >> (i - 1)) & 1 == 0 || (b >> (j - 1)) & 1 == 0, edges)
mis_size    = maximum(count_ones(b) for b in 0:(2^n - 1) if is_indep(b))
mis_states  = [b for b in 0:(2^n - 1) if is_indep(b) && count_ones(b) == mis_size]
@assert length(mis_states) == 1 "this template targets a unique-MIS instance; got $(length(mis_states)) — pick a graph with a unique MIS (the demo star qualifies)"
mis = mis_states[1]
println("graph: $n atoms, $(length(edges)) edges; MIS size $mis_size, bitstring $(string(mis, base = 2, pad = n)) (atom 1 = least-significant bit)")

# System: drift = pairwise blockade; two GLOBAL drives (Ω/2 Σσₓ, −Σn).
# Qubit convention per atom: |0⟩ ground, |1⟩ Rydberg; n̂ = |1⟩⟨1|.
kron_at(op, i) = kron([k == i ? op : sparse(I, 2, 2) for k in n:-1:1]...)  # atom i = bit i (LSB)
σx(i) = kron_at(sparse([0.0 1.0; 1.0 0.0]), i)
n̂(i)  = kron_at(sparse([0.0 0.0; 0.0 1.0]), i)

H_drift  = sum((C6 / dist(i, j)^6) * (n̂(i) * n̂(j)) for (i, j) in [(i, j) for i in 1:n for j in (i+1):n])
H_Ω      = 0.5 * sum(σx(i) for i in 1:n)
H_δ      = -sum(n̂(i) for i in 1:n)
sys = QuantumSystem(Matrix(H_drift), [Matrix(H_Ω), Matrix(H_δ)], [(0.0, Ω_max), δ_bounds])

ψ0 = zeros(ComplexF64, 2^n); ψ0[1] = 1.0            # all atoms in |0⟩
ψg = zeros(ComplexF64, 2^n); ψg[mis + 1] = 1.0      # the MIS bitstring

# Warm start: the textbook adiabatic ramp (never a zero seed) — Ω sin²-ramps up
# and back down, δ sweeps from strongly negative to the MIS-selecting plateau.
times   = collect(range(0.0, T, length = N))
Ω_seed  = [0.9 * Ω_max * sin(π * t / T)^2 for t in times]
δ_seed  = [0.8 * (δ_bounds[1] + (δ_bounds[2] - δ_bounds[1]) * t / T) for t in times]
initial = permutedims(hcat(Ω_seed, δ_seed))
qtraj = KetTrajectory(sys, ZeroOrderPulse(initial, times), ψ0, ψg)
P_seed = fidelity(qtraj)   # capture NOW — solve!'s sync mutates qtraj in place
println("adiabatic-ramp seed P(MIS) = ", round(P_seed; digits = 4))

# Δt is an optimization variable: bound it or the solver buys fidelity by
# silently stretching the sweep (observed: 2 μs → 13.8 μs unbounded). The
# (0.75, 1.5)× window keeps the duration comparable to T AND keeps the
# transcription-accuracy budget (‖H‖·Δt) that N was sized for.
qcp = SmoothPulseProblem(qtraj, N;
    piccolo_options = PiccoloOptions(timesteps_all_equal = true),
    Δt_bounds = (0.75 * T / N, 1.25 * T / N),
    Q = 100.0, R = 1e-2)
prob = hasproperty(qcp, :prob) ? qcp.prob : qcp

# Per-iter live plot + pulse telemetry: identical machinery to the vetted
# pulse-designer template (LivePulsePlotCallback is trajectory-generic).
const PLOT_EVERY = 6
live_plot = LivePulsePlotCallback(qtraj, prob.trajectory; every = PLOT_EVERY, save_dir = ".")

struct PulseEmitCallback <: AbstractIntermediateCallback
    inner::Any
    traj::Any
end
function (cb::PulseEmitCallback)(primal, iter)
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

let ls = "\"Ω\",\"δ\"",
    bs = "0:$(Ω_max),$(δ_bounds[1]):$(δ_bounds[2])"
    println("AMICODE_PULSE_META drives=2 knots=$N labels=$ls bounds=$bs")
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
# L-BFGS (eval_hessian=false): exact-Hessian assembly on this state size
# (2^n iso-dim × N knots) costs minutes per iteration — L-BFGS converges the
# waveform in wall-clock a hackathon can sit through. The quality upgrade for
# patient runs is a short exact-Hessian polish: solve!(qcp; max_iter=20) after.
solve!(qcp; max_iter = max_iter, eval_hessian = false, print_level = 1,
       options = IpoptOptions(intermediate_callback = pulse_emit),
       callback = CB.callback_factory(cb_log))
wall = time() - t0

# Verification: independent re-rollout of the OPTIMIZED PULSE through a fresh
# trajectory — never report the optimizer's own number (simulate-skill doctrine).
pulse_opt   = get_pulse(qcp.qtraj)
T_achieved  = duration(pulse_opt)
qtraj_check = KetTrajectory(sys, pulse_opt, ψ0, ψg)
P_mis       = fidelity(qtraj_check)
println("verified P(MIS) = ", round(P_mis; digits = 6), " at T = ", round(T_achieved; digits = 3),
        " μs (seed ramp gave ", round(P_seed; digits = 4), " at T = ", T, " μs)")
if P_mis < P_seed
    @warn "optimizer went BACKWARD vs the seed under independent rollout — the discrete transcription is too coarse for these energy scales. Raise N (and re-run); do not report this pulse." P_mis P_seed
end

# Final guarantee frame (same idiom as the vetted template).
let final_cb = LivePulsePlotCallback(qtraj, prob.trajectory; every = 1, save_dir = ".")
    tr = prob.trajectory
    final_primal = tr.global_dim > 0 ? vcat(collect(tr.datavec), collect(tr.global_data)) : collect(tr.datavec)
    final_cb(final_primal, iters[])
end

JLD2.save("pulse.jld2", "traj", prob.trajectory)   # key "traj" — warm-start/load_traj contract

# The Pulser seam: times + waveforms + register, consumed by templates/register.py.
# Hand-rolled JSON (numeric arrays + one string) — no JSON.jl dependency.
jnum(x) = isfinite(x) ? string(Float64(x)) : "null"
jarr(v)  = "[" * join(jnum.(v), ",") * "]"
# Read the optimized waveforms from the trajectory (get_knot_values is
# spline-only; ZeroOrderPulse has no method — the trajectory holds the knots).
t_opt = collect(Piccolo.get_times(prob.trajectory))
u_opt = Matrix(prob.trajectory[:u])
open("waveforms.json.tmp", "w") do io
    print(io, "{",
        "\"times_us\":", jarr(t_opt), ",",
        "\"omega_rad_us\":", jarr(u_opt[1, :]), ",",
        "\"delta_rad_us\":", jarr(u_opt[2, :]), ",",
        "\"positions_um\":[", join(("[" * jnum(p[1]) * "," * jnum(p[2]) * "]" for p in positions), ","), "],",
        "\"mis_bitstring\":\"", string(mis, base = 2, pad = n), "\"",
        "}")
end
mv("waveforms.json.tmp", "waveforms.json"; force = true)

open("result.toml.tmp", "w") do io
    TOML.print(io, Dict(
        "schema_version" => "1",
        "fidelity" => P_mis, "iterations" => iters[], "wall_seconds" => wall,
        "params" => Dict("n_atoms" => n, "n_edges" => length(edges), "mis_size" => mis_size,
                         "C6" => C6, "R_blockade" => R_blockade, "Omega_max" => Ω_max,
                         "T" => T, "T_achieved" => T_achieved, "N" => N, "max_iter" => max_iter),
    ))
end
mv("result.toml.tmp", "result.toml"; force = true)
println("DONE fidelity=$(P_mis)"); flush(stdout)
