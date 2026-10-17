---
name: quantum-motion
description: "Quantum Motion class silicon spin qubits — natural-Si MOS / 22 nm FDSOI dots, singlet-triplet (S-T0) encoding, full Heisenberg exchange control, gradient drift. Use when authoring or reviewing solves for a Quantum Motion-class silicon spin system, ST qubits, or shuttling-architecture spin hardware."
agents: [researcher, experimenter, engineer]
surface: public
revision: 1
---

# Quantum Motion class — silicon spin qubits (ST encoding)

Physics reference for Quantum-Motion-class silicon: gate-defined dots in
natural-Si MOS and 22 nm FDSOI (GlobalFoundries, arXiv:2310.20434;
arXiv:2507.21306), coherent exchange control demonstrated on this generation
(arXiv:2408.01241), and the theory team's ST-qubit erasure architecture
(arXiv:2601.10461). Companion card: `spin` (single-spin ZZ-exchange regimes —
different physics: ST needs the FULL exchange, see below).

## The ST qubit model (dual rotating frame)

Two electron spins in a double dot; basis (kron ordering)
$|{\uparrow\uparrow}\rangle, |{\uparrow\downarrow}\rangle, |{\downarrow\uparrow}\rangle, |{\downarrow\downarrow}\rangle$:

$$H(t) = \underbrace{\frac{\Delta}{4}(\sigma_z \otimes I - I \otimes \sigma_z)}_{\text{gradient drift}} + \underbrace{\frac{J(t)}{4}(\sigma_x \otimes \sigma_x + \sigma_y \otimes \sigma_y + \sigma_z \otimes \sigma_z)}_{\text{full Heisenberg exchange}}$$

- **Full exchange, NOT ZZ/4**: the S↔T0 mixing lives in the flip-flop
  ($\sigma_x\sigma_x + \sigma_y\sigma_y$) terms. The single-spin ZZ/4 effective
  form (`spin` card) is wrong physics for ST.
- $J(t) \in [0, J_{\max}]$ unipolar (barrier gate), $J_{\max}/2\pi \approx
  0.2$ GHz class (published-anchored placeholder — arXiv:2408.01241
  generation; real chips vary, intake replaces).
- $\Delta/2\pi \approx 10$ MHz gradient, quasi-static drift (micromagnet
  class). Gradient is the ORTHOGONAL logical axis: in the logical frame
  exchange $\to \sigma_z^{ST}$, gradient $\to \sigma_x^{ST}$.
- **$T_\pm$ symmetry isolation (exact)**: exchange conserves total $S_z$ and
  the gradient is diagonal — leakage out of the m=0 sector is structurally
  forbidden. Assert, don't model.

## The exchange π-rotation IS the SWAP gate

$Z_{ST}(\pi)$ = SWAP on the m=0 sector: target
$\mathrm{diag}(1, \sigma_x, 1)$ in the kron basis; the exact constant-$J$
solution at $\int J\,dt = 0.5$ cycles carries a global phase $e^{-i\pi/4}$
(fidelity is phase-invariant — the bare matrix target works with standard
unitary fidelity). Analytic speed floor: $T_{\min} = \pi/J_{\max}$
(2.5 ns at 0.2 GHz). At that floor **only one feasible pulse exists**
($J \equiv J_{\max}$, zero shaping freedom) — the gradient tilt
($\arctan(\Delta/2J)$) is then an unavoidable error: a fundamental
speed–fidelity frontier, not an optimizer limit.

## Verified recipe (SPEC-20261004-QM1, all re-rollout-verified)

| piece | value | note |
|---|---|---|
| formulation | `UnitaryTrajectory` + `EmbeddedOperator(U_full_4x4, sys)` + `ZeroOrderPulse` + `BangBangPulseProblem` | full-space custom matrix embed WORKS; `free_phase` gives ONE phase (single-subsystem interpretation) — needs a `HermitianExponentialIntegrator(qtraj, N; global_names=[:φ_1])` or construction errors |
| bounds | `QuantumSystem(2π.*[H_drift], 2π.*[H_ex], [(0.0, J_max)])` | unipolar |
| T=20 ns nominal | F = 0.99989 | sin² seed |
| **best** | **F = 0.99996 @ T = 10 ns** | honest T_min at F ≥ 0.999 |
| T ≤ 7.5 ns | ~0.9987 | speed-limit structure above |
| charge-noise audit (128-member quasi-static δJ, δΔ) | no cliff: σ=3e-3 → F̄ 0.9994; σ=1e-2 → 0.9948; σ=3e-2 → 0.956 | smooth first-order-predictable decay, GENTLER than the single-spin ZZ class (which cliffs below σ=5e-3) |

## Gotchas

1. **Area-exact analytic seeds are symmetric saddles.** A constant-$J$ seed
   with exactly $\int J\,dt = 0.5$ KKT-converges in ~25 iterations SITTING ON
   ITS OWN tilt error (T-independent F ≈ 0.9985 floor, recipe-robust). Seed
   with `J_max .* sin.(π .* times ./ T).^2` (area-inexact, shape-different)
   instead. Signature: converged-fast + fidelity ≈ the seed's rollout.
2. `free_phase=true` on a full-space custom `EmbeddedOperator` creates ONE
   global (`:φ_1`) — the integrator must declare exactly that, or `FieldError`.
3. `Δt` is always a variable on this stack — pin fixed-time with
   `Δt_bounds = (dt, dt)`.
4. Gradient-as-drift caps quality at short T (no compensation room); gradient
   as a CONTROL channel (their hardware tunes local fields) is the model
   decision that removes the cap — take it at intake.
5. Units: GHz + ns, 2π carried at `QuantumSystem` construction — never mix
   (the Groove P0g trap).

## Cross-references

- `spin` — single-spin ZZ-exchange hardware classes (Diraq/cryoCMOS/Quandela);
  free-phase-essential rule, unipolar exchange, `:CX`-not-`:CNOT`.
- `warm-start` + the analytic-seed-saddle lesson (vault memory
  `feedback_analytic_seed_saddle`).
- Open problems: two-ST-qubit CZ (the erasure architecture's 2Q primitive —
  unsolved in our corpus); robust ensemble re-synthesis (the smooth decay
  curve says a modest robustness term buys a lot); shuttling-pulse
  co-optimization (arXiv:2503.12767 — position as control knob).

> If this card is wrong — an API name, constant, or recipe that doesn't match
> observed reality — do the work, then file a finding (skills-integrity
> front-line rule). Never work around silently.
