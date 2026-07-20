#!/usr/bin/env julia
# Pasqal demo 3: packing parallel entangling operations.
#
# Two Bell pairs in one register — pair A at y=0, pair B at y=L, both 5 µm
# wide — driven by ONE global pulse into |Bell⟩_A ⊗ |Bell⟩_B. At large L the
# pairs are independent and the 2-atom optimized pulse works verbatim; as L
# shrinks, cross-pair interaction (∝1/L⁶) corrupts both. This script
# re-optimizes the pulse AT a given L with the cross-pair couplings in the
# model — crosstalk-aware control that buys back packing density. The layout
# question is exactly what dense code blocks (their [[4,2,2]] logical-qubit
# work, 99.4% gate fidelity) will face at scale.
#
# Usage: julia --project=$HOME/.amico/julia solve_pair_packing.jl [L_um]
# Output: pulse_pairs_L<L>.toml

using Piccolo
using TOML
using LinearAlgebra
using Random

Random.seed!(1234)

const Ω_MAX = 12.566370614359172e-3
const Δ_MAX = 125.66370614359172e-3
const C6 = 865723.02e-3
const CLOCK_NS = 4.0

L = length(ARGS) >= 1 ? parse(Float64, ARGS[1]) : 8.0
@assert L >= 5.0 "AnalogDevice minimum atom distance is 5 µm"

side = 5.0
atoms = [[0.0, 0.0], [side, 0.0], [0.0, L], [side, L]]   # A1 A2 B1 B2

T = 200.0
N = 51
max_iter = 400

σx = ComplexF64[0 1; 1 0]
n_r = ComplexF64[0 0; 0 1]
I2 = Matrix{ComplexF64}(I, 2, 2)

op_at(op, i) = kron([j == i ? op : I2 for j in 1:4]...)
Σσx = sum(op_at(σx, i) for i in 1:4)
Σn = sum(op_at(n_r, i) for i in 1:4)

dist(a, b) = hypot(a[1] - b[1], a[2] - b[2])
H_drift = sum(
    (C6 / dist(atoms[i], atoms[j])^6) * (op_at(n_r, i) * op_at(n_r, j))
    for i in 1:4 for j in (i+1):4
)

sys = QuantumSystem(H_drift, [Σσx / 2, -Σn], [(0.0, Ω_MAX), (-Δ_MAX, Δ_MAX)])

# |gggg⟩ → (|gr⟩+|rg⟩)/√2 ⊗ (|gr⟩+|rg⟩)/√2  (pairs A=(1,2), B=(3,4))
bell = zeros(ComplexF64, 4); bell[2] = bell[3] = 1 / sqrt(2)
ψ_init = zeros(ComplexF64, 16); ψ_init[1] = 1
ψ_goal = kron(bell, bell)

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

traj = get_trajectory(qcp)
fid = ket_rollout_fidelity(traj, sys; interpolation = :constant)

A = :u in traj.names ? traj.u : traj.a
Δt = first(Piccolo.get_timesteps(traj))

out = "pulse_pairs_L$(L).toml"
open(out, "w") do io
    TOML.print(io, Dict(
        "schema_version" => 1,
        "spike" => "pasqal-pair-packing-demo",
        "fidelity" => fid,
        "T_ns" => T,
        "dt_ns" => Δt,
        "n_knots" => N,
        "units" => "rad/us",
        "amplitude" => collect(A[1, :]) .* 1e3,
        "detuning" => collect(A[2, :]) .* 1e3,
        "atoms" => atoms,
        "target" => "bell-x-bell",
        "pair_gap_um" => L,
    ))
end

println("DONE fidelity=$(fid) L_um=$(L) out=$(out)")
