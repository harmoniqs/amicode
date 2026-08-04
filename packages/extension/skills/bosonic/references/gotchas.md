# Bosonic — Gotchas & key files

Edge cases to watch for, and where the bosonic code lives. Loaded on demand from
[`../SKILL.md`](../SKILL.md).

## Gotchas

1. **Many drive terms (4 + 7 = 11).** Far more than any qubit problem. Each nonlinear term needs a product-rule Jacobian. Use `NonlinearDrive` with analytical Jacobians; finite-difference gradients are inaccurate and slow.

2. **Stiff dynamics ($K_q/\chi \approx 6000{:}1$).** Transmon self-Kerr $K_q/2\pi = 200$ MHz vs dispersive shift $\chi/2\pi = 32.8$ kHz. Use `MagnusAdapt4Alg(tol=1e-6)`; Tsit5 alone will fail or produce incorrect results.

3. **Hessian required — L-BFGS destroys feasibility.** L-BFGS cannot handle the nonlinear control dependence of `NonlinearDrive` terms. Use the exact Gauss-Newton Hessian. This is the single biggest practical difference from Rydberg optimization.

4. **Free-phase sign convention.** Piccolo applies $\Phi(\theta)$ to the *goal* operator, not the propagated state. To target CPHASE($\pi$) with cavity phase $\phi_c$ and transmon phase $\phi_q$, set `initial_phases = [-phi_q, -phi_c]`. Wrong sign gives silently low fidelity.

5. **Large Hilbert space (~30–50 dim), expensive per iteration.** Even the minimal 3 × 10 = 30 configuration is larger than any Rydberg system (max $3^2 = 9$). GKP will push to $3 \times 25 = 75$. Matrix exponentials and propagator storage scale accordingly.

6. **ECD compiler targets displaced frame incorrectly.** The ECD protocol in the rotating frame requires $|\alpha| \sim 30$, mapping to $\sim$1 GHz drives — unphysical. The displaced frame with $|\alpha| \sim 4$–$5$ is the correct representation. Direct Piccolo optimization in the displaced frame is preferred.

7. **$K_c$ is tiny (3.25 Hz) but load-bearing.** On a 15 μs gate it contributes only $\sim$$3 \times 10^{-4}$ rad total phase, but dropping it changes the structure of the nonlinear drive operators. Keep it; it costs nothing numerically.

8. **Rad·GHz units internally.** Multiply standard kHz/MHz/GHz values by $2\pi$. E.g., $\chi/2\pi = 32.8$ kHz $\Rightarrow$ $\chi = 2\pi \times 32.8 \times 10^{-6}$ rad·GHz.

## Key files

Reference scripts for this platform live in a standalone `bosonic-demo` repo; authored
scripts must not `include` from it. The
displaced-frame GKP interface lives under `gkp-stanford/` (see
[gkp-stanford.md](gkp-stanford.md)).
