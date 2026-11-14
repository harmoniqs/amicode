---
name: scqubits
description: Using scqubits to build and label circuit-QED spectra — construction of fluxonium/transmon/Kerr subsystems and composite Hilbert spaces, the Kerr sign convention, the n_operator vs offset-charge trap, dressed-state labelling hazards, API shadowing after generate_lookup, and a truncation-convergence procedure with a per-quantity tolerance. Use when a script imports scqubits, when a spectrum, ZZ, chi, or dressed-frequency number is about to be reported, or before a hand-rolled eigenbasis is written.
agents: [researcher, experimenter, engineer]
surface: public
revision: 1
---

# scqubits — building and trusting spectra

scqubits is the source of record for qubit/coupler spectra and dressed-state labels; a hand-rolled eigenbasis is a second implementation to keep honest. This card is the construction recipe and — more importantly — the places where a plausible-looking number is wrong without an error.

> **Status: draft, verified on one fork.** API facts below were checked against the scqubits fork at `6b32be69` (`scqubits 4.3.1+g6b32be69c`, `harmoniqs/scqubits` main) on 2026-11-07, either by a smoke run for this card (marked *run*) or by file:line reading (marked *src*). Numbers marked *campaign* were measured in the fluxonium-cz geometry (fluxonium qubits at half flux, transmon/Kerr coupler) and **must be re-measured for your parameters**. Upstream scqubits may differ at other versions — line numbers are for the fork commit above.

## Units

Energies are **frequencies in GHz** (not angular). Convert explicitly at the boundary to any time-domain code: $H/h$ in GHz times $2\pi$ gives rad/ns.

## Construction

```python
import scqubits as scq

fl = scq.Fluxonium(EJ=4.0, EC=1.0, EL=1.0, flux=0.5, cutoff=110, truncated_dim=6, id_str="A")
cp = scq.Transmon(EJ=10.0, EC=0.3, ng=0.0, ncut=15, truncated_dim=4, id_str="cAB")
hs = scq.HilbertSpace([fl, cp])                       # subsystem order = label order
hs.add_interaction(g=0.05, op1=fl.n_operator, op2=cp.n_operator)   # g in GHz, H_int = g n_A n_c
```

- `truncated_dim` is the number of **dressed-subsystem levels kept** in the product basis; `cutoff` (fluxonium) / `ncut` (transmon) is the underlying diagonalisation basis. They converge separately — see *Convergence*.
- Interaction terms take the **operator callables** (`fl.n_operator`), not matrices; scqubits wraps them into the product basis.
- Dressed-state labels are bare-product tuples in **subsystem list order**: `(a, n_c, b)` for `[A, cAB, B]`.
- A Kerr resonator coupler: `scq.KerrOscillator(E_osc=w, K=K_scq, l_osc=1.0, truncated_dim=…)`. With `l_osc = 1`, $|\langle 0|n|1\rangle| = 1/\sqrt2$ (*run*: 0.70710678).

## The Kerr sign convention

scqubits' Kerr oscillator is $H = E_{\rm osc}\,a^\dagger a - K_{\rm scq}\,a^\dagger a^\dagger a a$ (*src*, class docstring). The usual problem convention is $H = \omega\, a^\dagger a + \tfrac{K}{2}\, a^\dagger a^\dagger a a$ (negative $K$ = anharmonic, $\omega_{12} = \omega + K$). The map is

$$E_{\rm osc} = \omega, \qquad K_{\rm scq} = -K/2 .$$

*Run*: $\omega = 3.465$, $K = -0.1$ GHz gives $\omega_{01} = 3.465$, $\omega_{12} = 3.365$. Re-check this on any new scqubits version before trusting it (the campaign's check agreed to $2\times10^{-15}$ GHz).

## The `n_operator` trap (offset charge)

`Transmon`'s Hamiltonian is $4E_C(\hat n - n_g)^2 - E_J\cos\hat\varphi$, but **`Transmon.n_operator()` is the plain integer charge** $\hat n$ (*run*: diagonal $-10,-9,-8,\dots$ at $n_g = 0.3$; *src* `transmon.py` `n_operator`). A coupling or drive built from `n_operator` therefore couples to $\hat n$, not $\hat n - n_g$. At $n_g = 0$ nothing changes; at $n_g \neq 0$ the extra term $g\,n_g\,\hat n_{\rm other}$ is a c-number times the partner's charge operator — an artefact if the physical coupling is capacitive.

In the campaign this produced spurious drive-line strengths and a spurious "dust" (multiphoton-resonance) onset at $n_g = 0.25$ that vanished once the coupling operator was $\hat n - n_g$. Whether the physical coupling is to $\hat n$ or $\hat n-n_g$ is a **modelling decision to state in your record** (the campaign adopted $\hat n - n_g$ for capacitive coupling); the library default is a trap, not a ruling. Pattern:

```python
import numpy as np, scipy.sparse as sps

class NgCorrTransmon(scq.Transmon):
    """n_operator returns n - n_g (the operator a capacitive coupling / voltage drive couples to)."""
    def n_operator(self, energy_esys=False):
        op = super().n_operator(energy_esys=energy_esys)
        I = sps.identity(op.shape[0], format=op.format) if sps.issparse(op) else np.eye(op.shape[0])
        return op - float(self.ng) * I
```

(`TunableTransmon` needs the same subclass.) At $n_g=0$ the subtraction is of an exact zero, so every matrix is bit-identical to the uncorrected one — a free regression check. Anything that reads `n_operator` downstream (line strengths, Floquet drive operators) inherits the choice, so correct it at the subclass, not at each call site.

## Labelling — where silent wrong answers come from

`hs.generate_lookup(...)` maps bare labels to dressed eigenstate indices; `hs.dressed_index(label)` reads it.

- **Default `ordering="DE"` drops low-overlap states.** A dressed state is assigned to a bare label only if the maximum overlap squared exceeds `scqubits.settings.OVERLAP_THRESHOLD` (= 0.5, *src* `spec_lookup.py` and `settings.py`); otherwise `dressed_index` returns **`None`**. *Run*: two identical transmons ($g=0.3$ GHz, exactly degenerate) gave `None` for $(0,1)$, $(1,0)$ and $(0,2)$ under DE; `HilbertSpace(..., ignore_low_overlap=True)` assigned all of them with **no purity report**. Treat `None` as information, and never "fix" it by lowering the threshold or forcing assignment without looking at the purity.
- **`ordering="BE"` / `"LX"` (branch analysis after Dumas et al. 2024)** labels states in bare-energy or lexical order and never refuses; it also reports **no purity and no warning**. In the campaign, at coupling $g$ comparable to detuning $\Delta$, BE swapped the one-photon coupler partners (pair) and the two coupler photons whenever the end qubit was excited (chain), with minimum purities 0.69 (pair) and 0.17–0.19 (chain). Against an independent labeller that moved $\chi_{01}$ by ≈7 MHz and $\delta\omega_{AB}$ by 14–18 MHz (*campaign*). *Run*: BE returned finite indices for the exactly degenerate pair above, without a warning.
- **Greedy max-overlap labelling breaks under hybridisation.** Bare-state labels stop being well-defined there; an "adiabatic" (continuation) label and a "bare-energy-ordered" label answer different questions for hybridised partner states. Say which one a number uses.
- **Check labels independently, and across every sweep.** A cheap independent labeller (*campaign*): walk $H(s) = H_0 + sV$ from $s=0$ to $1$ scaling all couplings together, match dressed vectors one-to-one on $|\langle {\rm prev}|{\rm new}\rangle|^2$ with the Hungarian algorithm, and halve the step whenever a matched overlap falls below 0.9. Report the minimum purity $|\langle {\rm bare}|{\rm dressed}\rangle|^2$ of the labelled states beside any labelled number. Verify continuity along each swept parameter; a label that flips between neighbouring sweep points is a bug in the number, not in the physics.
- `BEs_count` (BE only) is the number of states to label. The campaign used the count of bare states with energy ≤ (highest tracked bare level + 1.5 GHz), plus 10 (22 for the pair, 46 for the chain) — a choice, not a rule.

## API shadowing after `generate_lookup` (*run*, *src*)

- **`HilbertSpace.eigenvals()` / `eigensys()` shadow the lookup accessors** (`hilbert_space.py` lines 1002 and 1050 vs `spec_lookup.py` lines 402 and 422). After `generate_lookup` they **re-diagonalise with the default `evals_count=6`** instead of returning the spectrum the lookup indices refer to. *Run*: with `BEs_count=8` the stored spectrum had 8 entries and `hs.eigenvals()` had 6; indexing it by a `dressed_index` can raise `IndexError` or silently read the wrong eigenvalue.
  **Read the stored spectrum through `hs["evals"][0]` and `hs["evecs"][0]`** (eigenvectors are wrapped in an object array of length 1, a `QutipEigenstates` view; *src* `hilbert_space.py` near line 923).
- **`Oscillator.matrixelement_table` raises `NotImplementedError`** (`oscillator.py` ≈188; *run*), so generic $\langle 0|n_c|1\rangle$ code written for transmons fails on a Kerr coupler. Special-case oscillators (their `n_operator` is analytic).
- **`KerrOscillator` has no `hamiltonian()`** (*run*: `hasattr` False). Check conventions through `eigenvals()` or a matrix you build from `creation_operator()` / `annihilation_operator()`.

## Convergence — a ladder, not a default

scqubits has no truncation-convergence tool (campaign audit, 2026-11), so a script that ships a number must carry its own record.

**Procedure** (a procedure, not an API — the helper is project-local):

1. Define the base truncation (e.g. `cutoff, truncated_dim(fluxonium), truncated_dim(coupler), ncut`).
2. Raise each knob **separately**, then **all together**, and recompute every quantity you will report.
3. Measure the deviation against the **most-converged rung**, not against the base.
4. Judge each quantity against its own tolerance. The campaign's adopted rule:
   $$\mathrm{tol}(q) = \max\big(10^{-4}\ \mathrm{MHz},\ 10^{-3}\,|q|\big),$$
   since a 10 kHz spec on a GHz-scale coupler is a relative precision of ≈ $2\times10^{-6}$ and binds absolutely only where $q$ is near it. For log-slope fits use a purely relative tolerance.
5. Ship the **truncation record** with the number: the knobs, the rung, the deviation.

*Campaign* findings that should make you distrust defaults (re-measure for your geometry):

| observation | value |
|---|---|
| fluxonium `cutoff` 110 → 160 | moved all quantities ≤ $10^{-8}$ MHz |
| coupler `truncated_dim` 4 → 7 (strong-coupling transmon point) | moved $\chi_{11}$ by 1.31 MHz and $\delta\omega_{AB}$ by 0.575 MHz |
| fluxonium `truncated_dim` 6 → 10 (same point) | moved $\chi_{11}$ by 0.297 MHz |
| "production" truncation (110, 6, 4, 15) | did **not** hold $\chi$ to $10^{-4}$ MHz even at $g = 0.1\Delta$ (0.011 MHz movement for a transmon coupler) |
| successive-Δ sequence along the fluxonium-dimension ladder (strong point) | 0.42, 0.077, 7.9e-4, 4.6e-3, 8.8e-4 MHz — **non-monotone** |

Because the sequence can be non-monotone, "the last step moved less than tol" is a floor proxy, not a proof. Weak-coupling points converged at the base truncation for $\delta\omega_{AB}$ but still needed fluxonium `truncated_dim` ≥ 8 for $\zeta$ and $\chi$, and coupler dim ≥ 7 for a transmon. No chain truncation with Hilbert-space dimension ≤ 6000 held $10^{-4}$ MHz at the strong points.

## Solvers and cost

- scqubits' automatic diagonaliser used dense (qutip) below dimension 1000 and sparse `eigsh` (smallest algebraic, `tol=0`) above (*campaign* description of the auto path). At dimension 3456, dense / shift-invert `eigsh` / `primme` agreed to ≈$10^{-10}$ MHz; dense took 3.1–3.7 s.
- **Default shift-invert at dimension ≈ 49 000 did not finish in 18 minutes** (killed); an explicit sparse LU with a minimum-degree column ordering took 132–224 s, `primme` 43–62 s, `eigsh` with `which="SA"` 11–15 s (*campaign*, one machine).
- **Timings are load-dependent.** An early ledger quoted ≈5 s per point for the production eigensolver path; the full path (it includes a second diagonalisation inside `generate_lookup`) measured 36–62 s per point at box load 23–57 on 24 cores. Record the load beside any timing; use `detached-run` for anything long.

## Drive line strengths (a pattern, project-local)

To label a drive transition: for each initial dressed state $i$, with the drive operator $\hat O$ expressed in the same basis, $S_f = |\langle f|\hat O|i\rangle|^2$, $f^* = \arg\max_f S_f$, $\omega = E_{f^*}-E_i$. Report both $S_{\max}/\sum_{f\in{\rm window}}S_f$ and $S_{\max}/\langle i|\hat O^2|i\rangle$ (all states, including those outside the computed window); a single-resonance picture is only safe when the strongest line dominates (the campaign flagged a fraction below 0.9). Build $\hat O$ from the **corrected** charge operator above.

## Not covered here

- Exporting a dressed-basis model (Hamiltonian, labels, hand-built free phases, a lab-frame verifier) to an optimal-control solve, and a batch/Modal fan-out runner for scqubits scans, were proposed in the same campaign (S-fcz-01, items 2 and 3) and are **not yet cards**. Do not infer a recipe from this one.
- Upstream-fork changes the campaign suggested but did not make: an `n_operator(offset_subtracted=True)` option, purity output for branch analysis, and a convergence tool.

## Provenance

fluxonium-cz research campaign (2026-11-05 … 11-07): H0 spectrum-calibration observation note (conventions, ladder, label cross-check, API findings F-S1…F-S3, Q1), the project's `builders.py` / `metrics.py` / `ngcorr.py` helpers, D2a/D2b n_g notes, friction note F-fcz-13 and proposal S-fcz-01. Smoke checks for this card were run on 2026-11-07 against `scqubits 4.3.1+g6b32be69c`.

## Related

- `detached-run` — long diagonalisations; `prereg-seal` — if a convergence tolerance is a pre-registered key.
- `fluxonium`, `transmon` — device physics and parameter choices (if available in your session).
