#!/usr/bin/env julia
# Pasqal demo 2: geometry is the program — W-state on triangle vs chain.
#
# Three atoms, global drive only. Target: W = (|rgg⟩+|grg⟩+|ggr⟩)/√3 from
# |ggg⟩. A W state needs EVERY pair blockaded (one shared excitation). An
# equilateral triangle at 5 µm blockades all three pairs; a 5 µm chain leaves
# the end atoms 10 µm apart (V ≈ 0.85 rad/µs — no blockade), so the same
# global pulse CANNOT protect the ends from double excitation. The register
# geometry — not the pulse — decides what state is reachable: the disk-graph
# idea (arXiv:2506.13228) in one picture.
#
# Usage: julia --project=$HOME/.amico/julia solve_w_state.jl [triangle|chain]
# Output: pulse_w_<geometry>.toml

using Piccolo
using TOML
using LinearAlgebra
using Random

Random.seed!(1234)

const Ω_MAX = 12.566370614359172e-3   # rad/ns (AnalogDevice max_amp)
const Δ_MAX = 125.66370614359172e-3
const C6 = 865723.02e-3               # rad/ns · µm⁶
const CLOCK_NS = 4.0

geometry = length(ARGS) >= 1 ? ARGS[1] : "triangle"
side = 5.0                            # µm, the device minimum
atoms = geometry == "triangle" ?
    [[0.0, 0.0], [side, 0.0], [side / 2, side * sqrt(3) / 2]] :
    [[0.0, 0.0], [side, 0.0], [2side, 0.0]]

T = 200.0
N = 51
max_iter = 300

σx = ComplexF64[0 1; 1 0]
n_r = ComplexF64[0 0; 0 1]
I2 = Matrix{ComplexF64}(I, 2, 2)

op_at(op, i) = kron([j == i ? op : I2 for j in 1:3]...)
Σσx = sum(op_at(σx, i) for i in 1:3)
Σn = sum(op_at(n_r, i) for i in 1:3)

dist(a, b) = hypot(a[1] - b[1], a[2] - b[2])
H_drift = sum(
    (C6 / dist(atoms[i], atoms[j])^6) * (op_at(n_r, i) * op_at(n_r, j))
    for i in 1:3 for j in (i+1):3
)

sys = QuantumSystem(H_drift, [Σσx / 2, -Σn], [(0.0, Ω_MAX), (-Δ_MAX, Δ_MAX)])

# |ggg⟩ → W; basis index of the single-r states: |rgg⟩=5, |grg⟩=3, |ggr⟩=2
# with |g⟩=[1,0], |r⟩=[0,1] and kron(atom1, atom2, atom3) ordering (1-based).
ψ_init = zeros(ComplexF64, 8); ψ_init[1] = 1
ψ_goal = zeros(ComplexF64, 8)
ψ_goal[2] = ψ_goal[3] = ψ_goal[5] = 1 / sqrt(3)

times = collect(range(0.0, T, length = N))
Ω_naive = π / (sqrt(3) * T)           # collective √3-enhanced π area
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

out = "pulse_w_$(geometry).toml"
open(out, "w") do io
    TOML.print(io, Dict(
        "schema_version" => 1,
        "spike" => "pasqal-w-state-geometry-demo",
        "fidelity" => fid,
        "T_ns" => T,
        "dt_ns" => Δt,
        "n_knots" => N,
        "units" => "rad/us",
        "amplitude" => collect(A[1, :]) .* 1e3,
        "detuning" => collect(A[2, :]) .* 1e3,
        "atoms" => atoms,
        "target" => "w-state",
        "geometry" => geometry,
    ))
end

println("DONE fidelity=$(fid) geometry=$(geometry) out=$(out)")
