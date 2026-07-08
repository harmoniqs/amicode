#!/usr/bin/env julia
# Piccolo→Pulser translation spike, solve side.
#
# Solves an X gate on the ground–rydberg two-level system {|g⟩, |r⟩} under
# Pasqal AnalogDevice constraints, parameterized so the solved controls map
# 1:1 onto a Pulser Pulse with zero additional algebra:
#
#   H(t) = u1(t) · σx/2  +  u2(t) · (−|r⟩⟨r|)
#
# matches Pulser's  H = Ω(t)·σx/2 − Δ(t)·|r⟩⟨r|  (phase φ = 0), so
# u1 IS Ω(t) and u2 IS Δ(t), Pulser sign convention included.
#
# Constraints mirrored from pulser.AnalogDevice's rydberg_global channel:
#   Ω ∈ [0, 12.566] rad/µs   (amplitude is nonnegative in Pulser)
#   Δ ∈ [−125.66, 125.66] rad/µs
#   clock period 4 ns  →  Δt pinned to 4 ns (ZOH knots land on the clock grid)
#
# Units here: rad/ns and ns (Piccolo convention). rad/µs = 1e-3 rad/ns.
#
# Output: pulse.toml in the working directory — knot-level Ω/Δ arrays in
# rad/µs (Pulser's units), dt, and the solved fidelity.

using Piccolo
using TOML
using LinearAlgebra
using Random

Random.seed!(1234)

# ── Pasqal AnalogDevice constraints (rad/ns) ─────────────────────────────
const Ω_MAX = 2π * 0.002    # 12.566 rad/µs  → 0.012566 rad/ns
const Δ_MAX = 2π * 0.02    # 125.66 rad/µs  → 0.12566 rad/ns
const CLOCK_NS = 4.0

T = 400.0            # gate time (ns); π-pulse speed limit is ~250 ns at Ω_MAX
N = 101              # knots → 100 intervals × 4 ns = 400 ns on the clock grid
max_iter = 300

# ── System: {|g⟩, |r⟩}, drives map 1:1 onto Pulser channels ──────────────
σx = ComplexF64[0 1; 1 0]
n_r = ComplexF64[0 0; 0 1]

sys = QuantumSystem(
    zeros(ComplexF64, 2, 2),          # resonant frame, no drift
    [σx / 2, -n_r],                   # [amplitude, detuning (Pulser sign)]
    [(0.0, Ω_MAX), (-Δ_MAX, Δ_MAX)],
)

goal = GATES[:X]

# Initial guess: amplitude near the π-area mean (∫Ω dt = π), detuning ~0.
times = collect(range(0.0, T, length = N))
u_init = vcat(
    clamp.(fill(π / T, N)' .+ 0.05Ω_MAX * randn(1, N), 0.05Ω_MAX, 0.95Ω_MAX),
    0.01Δ_MAX * randn(1, N),
)

qtraj = UnitaryTrajectory(sys, ZeroOrderPulse(u_init, times), goal)
qcp = SmoothPulseProblem(qtraj, N;
    piccolo_options = PiccoloOptions(timesteps_all_equal = true),
    Δt_bounds = (CLOCK_NS, CLOCK_NS),   # pin to the AnalogDevice clock grid
    Q = 100.0, R = 1e-2)

solve!(qcp; max_iter = max_iter, print_level = 1)

# Rollout fidelity (fresh high-tolerance integration, phase-invariant).
traj = get_trajectory(qcp)
Uroll = iso_vec_to_operator(unitary_rollout(traj, sys)[:, end])
fid = abs2(tr(Uroll' * goal)) / size(goal, 1)^2

# ── Export knots in Pulser's units (rad/µs) ──────────────────────────────
A = :u in traj.names ? traj.u : traj.a
Δt = first(Piccolo.get_timesteps(traj))
amplitude = collect(A[1, :]) .* 1e3    # rad/ns → rad/µs
detuning = collect(A[2, :]) .* 1e3

open("pulse.toml", "w") do io
    TOML.print(io, Dict(
        "schema_version" => 1,   # pulse_contract.py checks this exactly
        "spike" => "piccolo-to-pulser-x-gate",
        "fidelity" => fid,
        "T_ns" => T,
        "dt_ns" => Δt,
        "n_knots" => N,
        "units" => "rad/us",
        "amplitude" => amplitude,
        "detuning" => detuning,
    ))
end

println("DONE fidelity=$(fid) dt=$(Δt) knots=$(N)")
