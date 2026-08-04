# Atoms — The analog register workflow

For users who think in **registers and ramps**, not gates: adiabatic state preparation,
combinatorial-optimization encodings (MIS and friends), and the physicality checks a
schedule must pass before it is worth submitting anywhere. Loaded on demand from
[`../SKILL.md`](../SKILL.md).

Signals you are in this workflow, not the gate workflow: the user says *register*, *ramp*,
*anneal*, *adiabatic*, *MIS*, *ground state*, *bitstrings*, *shots*. There is no $U_{goal}$ —
the target is a **state**, and the answer comes back as measured bitstrings.

## The three things you choose

| Choice | What it is | Where it lives |
|---|---|---|
| **Register** | atom positions in µm | `positions` → `H_drift` (geometry *is* the problem encoding) |
| **Schedule** | $\Omega(t), \Delta(t)$ over the whole register | the pulse — two arrays |
| **Duration** | total ramp time $T$ | adiabaticity vs. coherence budget |

Everything else follows. Note the asymmetry from the gate workflow: there, geometry is fixed
and the pulse does the work; here, **geometry carries the problem** and the pulse only has to
get you adiabatically to the ground state.

## Encoding: MIS on a unit-disk graph

The Rydberg blockade is a hard constraint "no two blockaded atoms are both excited" — which
is exactly the independent-set constraint. So:

1. Place one atom per graph vertex.
2. Choose the spacing so that **edges of the graph = pairs within the blockade radius**
   $R_b = (C_6/\Omega)^{1/6}$. Connected ⇒ closer than $R_b$; non-adjacent ⇒ comfortably
   further.
3. Drive with $\Delta > 0$ at the end of the ramp, which rewards excitation. The ground
   state of $H(\Delta \gg 0)$ maximizes the number of excited atoms **subject to** the
   blockade constraint — a maximum independent set.
4. Measure. The returned bitstrings are candidate independent sets; the modal one, checked
   against the graph, is your answer.

The honest caveat to state up front: this encodes MIS **on unit-disk graphs**, the graphs
realizable by positions in the plane. An arbitrary graph does not embed, and pretending it
does is the single most common overclaim in this workflow. If the user's graph is not
unit-disk, say so and discuss the embedding cost rather than silently solving a different
problem.

```julia
using Piccolo, LinearAlgebra
const ⊗ = kron

# Vertices of a unit-disk graph, µm. Edges = pairs within the blockade radius.
positions = [(0.0, 0.0), (7.0, 0.0), (14.0, 0.0), (3.5, 6.1), (10.5, 6.1)]
N  = length(positions)
C6 = 862_690 * 2π                      # rad/µs · µm⁶
Ω_MAX, Δ_MAX = 15.8 * 2π, 124.0 * 2π

n_r = ComplexF64[0 0; 0 1]; σx = ComplexF64[0 1; 1 0]
I2  = Matrix{ComplexF64}(I, 2, 2)
lift(op, i, N) = reduce(⊗, [k == i ? op : I2 for k in 1:N])

R_b = (C6 / Ω_MAX)^(1/6)
@info "blockade radius" R_b_um = R_b
for i in 1:N, j in (i+1):N
    r = hypot(positions[i][1]-positions[j][1], positions[i][2]-positions[j][2])
    @info "pair" i j r_um = round(r; digits=2) blockaded = (r < R_b)
end                                     # ← READ THIS before solving anything

H_drift = zeros(ComplexF64, 2^N, 2^N)
for i in 1:N, j in (i+1):N
    r = hypot(positions[i][1]-positions[j][1], positions[i][2]-positions[j][2])
    H_drift += (C6 / r^6) * lift(n_r, i, N) * lift(n_r, j, N)
end
H_Ω = sum(lift(σx, i, N) for i in 1:N) / 2
H_Δ = -sum(lift(n_r, i, N) for i in 1:N)
sys = QuantumSystem(H_drift, [H_Ω, H_Δ], [(0.0, Ω_MAX), (-Δ_MAX, Δ_MAX)])
```

## The schedule: an adiabatic ramp, and how to improve it

The textbook ramp is three phases: turn $\Omega$ on at large negative $\Delta$, sweep
$\Delta$ from negative to positive at (roughly) constant $\Omega$, then turn $\Omega$ off.

```julia
# Slew ceiling: Ω is the binding channel, 250/15.8 = 15.8 /µs, so N ≤ 4.0×15.8 + 1 = 64.
# A ramp is a simple shape; 33 knots (32 intervals, balances on 4 and 8 threads) resolves
# the minimum-gap region with room to spare. 101 knots would sit ~1.6× above the ceiling.
Ω_SLEW, Δ_SLEW = 250.0 * 2π, 2000.0 * 2π    # rad/µs² — published slew caps
T, N_knots = 4.0, 33                        # µs
times = collect(range(0.0, T, length = N_knots))
s = times ./ T

Ω_ramp = @. Ω_MAX * min(1.0, 10s) * min(1.0, 10(1 - s))   # on, hold, off
Δ_ramp = @. Δ_MAX * (2s - 1) * 0.3                         # −0.3Δ_max → +0.3Δ_max
pulse  = LinearSplinePulse(vcat(Ω_ramp', Δ_ramp'), times)  # ramps are what the device plays
```

A piecewise-linear pulse is not a stylistic choice here: an adiabatic schedule *is* a set of
ramps, and this hardware executes ramps under a hard slew cap. `LinearSplinePulse` makes the
optimizer's `du` the actual ramp slope, so `du_bounds` keeps every segment inside the published
cap — no post-hoc resampling that would change the schedule you verified.

**Use this as a warm start, not as the answer.** A linear sweep spends most of its time where
the gap is large and rushes the minimum gap, which is precisely backwards. Optimizing the
ramp shape is where Piccolo earns its keep on this workflow:

```julia
ψ0 = zeros(ComplexF64, 2^N); ψ0[1] = 1.0        # all atoms in |g⟩
# Target: the ground state of the final Hamiltonian (the MIS state).
H_final  = H_drift + 0.3Δ_MAX * H_Δ
ψ_goal   = eigvecs(Hermitian(H_final))[:, 1]

qtraj = KetTrajectory(sys, pulse, ψ0, ψ_goal)
println("naive ramp fidelity = ", fidelity(qtraj))     # the baseline to beat

Δt_nom = T / (N_knots - 1)                  # 0.125 µs
qcp = SplinePulseProblem(qtraj;
    du_bounds = [Ω_SLEW, Δ_SLEW],           # per-channel; the caps differ 8×
    Q = 200.0, R_u = 1e-4, R_du = 1e-5,
    Δt_bounds = (0.3Δt_nom, 3.0Δt_nom))     # FREE time — the whole point, see below
solve!(qcp; max_iter = 300)
println("optimized ramp fidelity = ", fidelity(qcp))
```

**Leave the timesteps free here — it is the mechanism, not a detail.** The complaint about the
naive ramp is that it spends its time in the wrong places: lots of it where the gap is large,
too little at the minimum gap. Free, unequal timesteps are exactly how the optimizer fixes
that — it redistributes duration toward the avoided crossing while holding the knot count
fixed. Pinning `Δt_bounds = (Δt_nom, Δt_nom)`, or setting
`PiccoloOptions(timesteps_all_equal = true)`, forbids the one move the schedule most needs, and
you are left optimizing only the ramp's shape at a fixed time budget per segment.

Both are Piccolo's non-defaults anyway (`timesteps_all_equal` is `false` out of the box). Pin
the grid **only** when emitting to a device clock, which is the `pasqal` skill's job and happens
after this solve — not during it.

Always print the naive-ramp number first. "Optimization improved fidelity from 0.87 to 0.998"
is a result; "we got 0.998" is not, because nobody knows what the free baseline was. This
baseline discipline is the same one the `simulate` skill applies to gates.

## Degenerate ground states

MIS instances frequently have several maximum independent sets, so the "ground state" is a
degenerate subspace and targeting one specific eigenvector is an arbitrary and unnecessarily
hard demand. Two honest options:

- Target the **subspace**: use `MultiKetTrajectory` over the degenerate manifold, or
  maximize total population in it rather than overlap with one member.
- Target the **observable**: what the user wants is a large independent set, so score the
  returned bitstrings by set size and validity. Optimize for that, and report the
  distribution — not a single fidelity.

Do not silently pick one eigenvector and report its fidelity as the answer quality. It
undersells a good schedule and misleads about what the device will return.

## Physicality checks — run these before submitting anything

| Check | Rule | Why it bites |
|---|---|---|
| **Amplitude sign** | $\Omega \geq 0$ everywhere | hardware has no negative amplitude; the sign is the phase |
| **Bounds** | $\Omega \leq \Omega_{\max}$, $\|\Delta\| \leq \Delta_{\max}$ | a solve sitting past a bound is a bad solve, not a rounding issue |
| **Slew** | $\|\dot\Omega\|, \|\dot\Delta\|$ within published slew rates | the device low-passes what you asked for; the executed pulse ≠ your pulse |
| **Clock grid** | timestep an integer multiple of the channel clock period | off-grid knots get resampled underneath you |
| **Duration** | within the device max sequence duration | and within the Rydberg lifetime — a 100 µs "adiabatic" ramp is decoherence, not adiabaticity |
| **Min spacing** | every pair ≥ device minimum atom distance | otherwise the register is not loadable |
| **Trotter/step sanity** | $\|H\| \cdot \Delta t$ small | a schedule that is "adiabatic" only because the integrator is coarse is a numerical fiction |

The `pasqal` skill turns these into an executable check against a real device object and then
submits — device limits read from the device at call time, never hardcoded. Run it before you
spend shots.

## Reporting

The deliverable is not a fidelity, it is **measured bitstrings plus what they mean**: the
modal bitstring, whether it is a valid independent set on the user's graph, its size versus
the true optimum (compute the optimum classically for small $N$ — do it, it is cheap and it
is the only honest calibration of the result), and the shot distribution. A run that returns
a valid-but-suboptimal set is a real result and should be reported as one; a run whose modal
bitstring violates the graph's constraints means the encoding, not the optimizer, is wrong.
