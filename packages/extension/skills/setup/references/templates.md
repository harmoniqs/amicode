# Setup — Complete templates (Rule 10)

End-to-end script templates for the two entry points: a cold start (no prior solution) and a
warm start (loading a prior solution). Loaded on demand from [`../SKILL.md`](../SKILL.md).
See [rules.md](rules.md) for the rationale behind each choice.

## Cold Start (no prior solution)

```julia
using Piccolo

# 1. Build system — TransmonSystem is used here because it is the shortest real
#    constructor. For your hardware see /fluxonium (no template — you build it),
#    /atoms (RydbergChainSystem), /ions (IonChainSystem), /bosonic (CatSystem).
sys = TransmonSystem(ω = 4.0, δ = 0.2, levels = 5, drive_bounds = [0.1, 0.1])

# 2. Build cubic spline pulse. T near the physical optimum (Rule 3 — not "generous");
#    N_knots-1 = 16 intervals, so it balances on 4 and 8 threads.
T = 25.0  # ns
N_knots = 17
times   = collect(range(0.0, T, length = N_knots))
u_init  = 0.1 * randn(sys.n_drives, N_knots)     # within drive_bounds; never all-zero
du_init = zeros(sys.n_drives, N_knots)
pulse = CubicSplinePulse(u_init, du_init, times)

# 3. Build trajectory + integrator + problem
Δt_nom = T / (N_knots - 1)                       # 1.5625 ns
qtraj = UnitaryTrajectory(sys, pulse, U_goal)
integrator = SplineIntegrator(qtraj, N_knots; alg=MagnusAdapt4Alg(tol=1e-8))
qcp = SplinePulseProblem(qtraj;
    integrator=integrator,
    Q=100_000.0, R_u=1e-4, R_du=1e-5,
    du_bound=0.1,                                # GHz/ns — AWG slew; see the platform card
    Δt_bounds=(0.3Δt_nom, 3.0Δt_nom),
)

# 4. Phase 1: L-BFGS fidelity exploration
solve!(qcp; max_iter=300, eval_hessian=false)
jldsave("data/X_lbfgs_fid" * ".jld2"; pulse = get_pulse(qcp.qtraj))

# 5. Phase 2: Exact Hessian fidelity refinement
solve!(qcp; max_iter=300)
jldsave("data/X_fidelity" * ".jld2"; pulse = get_pulse(qcp.qtraj))

# 6. Phase 3: L-BFGS min-time exploration
qcp_min = MinimumTimeProblem(qcp; final_fidelity=0.999, D=100.0)
solve!(qcp_min; max_iter=1000, eval_hessian=false)
jldsave("data/X_lbfgs_mt" * ".jld2"; pulse = get_pulse(qcp_min.qtraj))

# 7. Phase 4: Exact Hessian min-time refinement (reload checkpoint)
pulse2, _ = load_pulse("data/X_lbfgs_mt.jld2")
# ... rebuild problem from pulse2 ...
qcp_min2 = MinimumTimeProblem(qcp2; final_fidelity=0.999, D=100.0)
solve!(qcp_min2; max_iter=500)
jldsave("data/X_mintime" * ".jld2"; pulse = get_pulse(qcp_min2.qtraj))
# Duration emerges naturally (e.g., 8 ns for X gate)
```

## Warm Start (loading a prior solution)

```julia
using Piccolo

# 1. Build system (same as cold start) — TransmonSystem is used here because it is the shortest real
#    constructor. For your hardware see /fluxonium (no template — you build it),
#    /atoms (RydbergChainSystem), /ions (IonChainSystem), /bosonic (CatSystem).
sys = TransmonSystem(ω = 4.0, δ = 0.2, levels = 5, drive_bounds = [0.1, 0.1])

# 2. Load existing pulse
pulse, meta = load_pulse("data/X_fidelity.jld2")
N_knots = get_knot_count(pulse)

# 3. Rebuild trajectory + integrator + problem. Bounds follow the LOADED pulse's own grid,
#    so derive Δt_nom from it rather than reusing the cold-start numbers.
Δt_nom = duration(pulse) / (N_knots - 1)
qtraj = UnitaryTrajectory(sys, pulse, U_goal)
integrator = SplineIntegrator(qtraj, N_knots; alg=MagnusAdapt4Alg(tol=1e-8))
qcp = SplinePulseProblem(qtraj;
    integrator=integrator,
    Q=100_000.0, R_u=1e-4, R_du=1e-5,
    du_bound=0.1, Δt_bounds=(0.3Δt_nom, 3.0Δt_nom),
)

# 4. Exact Hessian fidelity refinement (skip L-BFGS — already have good solution)
solve!(qcp; max_iter=300)
jldsave("data/X_fidelity_v2" * ".jld2"; pulse = get_pulse(qcp.qtraj))

# 5. L-BFGS min-time exploration
qcp_min = MinimumTimeProblem(qcp; final_fidelity=0.999, D=100.0)
solve!(qcp_min; max_iter=1000, eval_hessian=false)
jldsave("data/X_lbfgs_mt" * ".jld2"; pulse = get_pulse(qcp_min.qtraj))

# 6. Exact Hessian min-time refinement
solve!(qcp_min; max_iter=500)
jldsave("data/X_mintime" * ".jld2"; pulse = get_pulse(qcp_min.qtraj))
```
