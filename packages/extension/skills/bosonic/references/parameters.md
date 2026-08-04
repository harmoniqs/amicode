# Bosonic — Default parameters, integrator & trajectory type

Default optimization parameters, integrator choice for the stiff dispersive system, and the
trajectory type. Loaded on demand from [`../SKILL.md`](../SKILL.md).

## Default Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| Pulse / template | `LinearSplinePulse` / `SplinePulseProblem` | 11 drives — cubic would double the control block |
| N_knots | **25** | $N-1 = 24$ intervals: balances on 2/3/4/6/8/12 threads |
| T (drift warm start) | 15,244 ns | $T = \pi/\chi$; exact CPHASE($\pi$) |
| Q | 100,000 | Infidelity weight |
| R | 1e-4 | Amplitude regularization |
| du_bound | 5.0 | Rad·GHz/ns slew rate |
| $\Delta t$ bounds | **[190, 1905] ns** | $(0.3, 3.0)\times T/(N-1)$; nominal 635 ns |

**Why 25 and not 48.** CPHASE from the drift warm start does not need a richly structured pulse:
the drift produces the gate on its own at $T = \pi/\chi$, and the drives are a *correction*. A
smooth correction with a handful of lobes is what 25 knots buys, and it keeps the NLP small on a
problem that is already expensive for two independent reasons — 11 drives, and a $K_q/\chi
\approx 6000{:}1$ stiffness ratio that forces an adaptive Magnus integrator and an exact
Hessian. The old 48 also gave 47 intervals, a prime, which load-balances on no thread count.

Raise `N` only if the correction genuinely needs more structure — GKP state preparation does,
and keeps its own validated value (see `bosonic-gkp`).

## Integrator

Use `MagnusAdapt4Alg(tol=1e-6)` — adaptive Magnus integrator for stiff dynamics. The
$K_q/\chi \approx 6000{:}1$ stiffness ratio requires resolving both the fast transmon
oscillation and the slow dispersive phase accumulation.

```julia
integrator = SplineIntegrator(qtraj, N_knots; alg=MagnusAdapt4Alg(tol=1e-6))
```

Sensitivity equations always use Tsit5; add `maxiters=1_000_000` if they stall.

## Trajectory Type

`MultiKetTrajectory` — state transfer with $2 \times N_{\text{Fock}}$ ket pairs. Avoids the
$O(d^3)$ cost of full unitary propagation for a 30-dim space.
