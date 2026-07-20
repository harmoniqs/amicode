#!/usr/bin/env julia
# Pasqal demo: optimize a Bell-state preparation pulse at a given atom spacing.
#
# Two atoms in Pasqal's analog (ground–rydberg) mode. The blockade interaction
# V = C6/d^6 entangles them; the target is the symmetric Bell state
# (|gr⟩ + |rg⟩)/√2 prepared from |gg⟩. At AnalogDevice's 5 µm minimum spacing
# the blockade is MODERATE (V/Ω ≈ 4.9), where the naive blockade-π protocol
# tops out near 96.8% — the optimizer's job is to beat it with amplitude +
# detuning shaping.
#
# Hamiltonian is parameterized in Pulser's own terms (see solve_x_gate.jl):
#   H = u1(t)·Σᵢσx⁽ⁱ⁾/2 + u2(t)·(−Σᵢn⁽ⁱ⁾) + (C6/d⁶)·n⊗n
# so u1 IS Ω(t), u2 IS Δ(t), Pulser sign convention included.
#
# Usage: julia --project=$HOME/.amico/julia solve_bell_state.jl [spacing_um]
# Output: pulse_bell_d<spacing>.toml (schema_version 1 + additive `atoms` key)

using Piccolo
using TOML
using LinearAlgebra
using Random

Random.seed!(1234)

# ── Pasqal AnalogDevice constants (rad/ns; from pulser at runtime they are
# rad/µs — ×1e-3 here). C6 is the device's interaction_coeff at n=60.
const Ω_MAX = 12.566370614359172e-3
const Δ_MAX = 125.66370614359172e-3
const C6 = 865723.02e-3            # rad/ns · µm⁶
const CLOCK_NS = 4.0

spacing_um = length(ARGS) >= 1 ? parse(Float64, ARGS[1]) : 5.0
@assert spacing_um >= 5.0 "AnalogDevice minimum atom distance is 5 µm"

V = C6 / spacing_um^6              # rad/ns
T = 200.0                          # ns; naive enhanced-π is ~196 ns
N = 51                             # 50 intervals × 4 ns = 200 ns
max_iter = 300

# ── Two-atom ground–rydberg system, Pulser-matched ───────────────────────
σx = ComplexF64[0 1; 1 0]
n_r = ComplexF64[0 0; 0 1]          # |r⟩⟨r|, with |g⟩=[1,0], |r⟩=[0,1]
I2 = Matrix{ComplexF64}(I, 2, 2)

Σσx = kron(σx, I2) + kron(I2, σx)
Σn = kron(n_r, I2) + kron(I2, n_r)
H_drift = V * kron(n_r, n_r)

sys = QuantumSystem(
    H_drift,
    [Σσx / 2, -Σn],
    [(0.0, Ω_MAX), (-Δ_MAX, Δ_MAX)],
)

# |gg⟩ → (|gr⟩ + |rg⟩)/√2
ψ_init = ComplexF64[1, 0, 0, 0]
ψ_goal = ComplexF64[0, 1, 1, 0] / sqrt(2)

# Warm start: the naive blockade protocol (constant Ω, enhanced Rabi √2·Ω,
# π area over T) plus a whisper of noise so derivatives aren't degenerate.
times = collect(range(0.0, T, length = N))
Ω_naive = π / (sqrt(2) * T)
u_init = vcat(
    clamp.(fill(Ω_naive, N)' .+ 0.02Ω_MAX * randn(1, N), 0.05Ω_MAX, 0.95Ω_MAX),
    0.005Δ_MAX * randn(1, N),
)

qtraj = KetTrajectory(sys, ZeroOrderPulse(u_init, times), ψ_init, ψ_goal)
qcp = SmoothPulseProblem(qtraj, N;
    piccolo_options = PiccoloOptions(timesteps_all_equal = true),
    Δt_bounds = (CLOCK_NS, CLOCK_NS),
    Q = 200.0, R = 1e-2)

solve!(qcp; max_iter = max_iter, print_level = 1)

# Rollout fidelity from a fresh high-tolerance integration; :constant
# interpolation matches the zero-order hold Pulser will actually execute.
traj = get_trajectory(qcp)
fid = ket_rollout_fidelity(traj, sys; interpolation = :constant)

A = :u in traj.names ? traj.u : traj.a
Δt = first(Piccolo.get_timesteps(traj))
amplitude = collect(A[1, :]) .* 1e3    # rad/ns → rad/µs
detuning = collect(A[2, :]) .* 1e3

out = "pulse_bell_d$(spacing_um).toml"
open(out, "w") do io
    TOML.print(io, Dict(
        "schema_version" => 1,
        "spike" => "pasqal-bell-state-position-demo",
        "fidelity" => fid,
        "T_ns" => T,
        "dt_ns" => Δt,
        "n_knots" => N,
        "units" => "rad/us",
        "amplitude" => amplitude,
        "detuning" => detuning,
        "atoms" => [[0.0, 0.0], [spacing_um, 0.0]],   # µm; additive schema key
        "target" => "bell-gr+rg",
    ))
end

println("DONE fidelity=$(fid) spacing_um=$(spacing_um) V_over_Omega=$(round(V/Ω_MAX; digits=2)) out=$(out)")
