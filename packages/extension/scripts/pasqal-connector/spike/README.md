# Piccolo→Pulser translation spike

Proves a Piccolo-optimized pulse survives translation into Pulser and executes
correctly on Pasqal's `AnalogDevice` model. Companion to the connectivity probe
one directory up (`../pasqal_connect.py`); together they de-risk the two halves
of the Pasqal connector: the wire, and the payload.

## Result (2026-07-08)

| Stage | Fidelity |
|---|---|
| Piccolo solve (X gate on {\|g⟩,\|r⟩}, 400 ns, Pasqal constraints) | 0.99999999 |
| Pulser + QuTiP re-simulation of the translated sequence | 0.999999 |
| Same, with the 8 MHz output-modulation filter enabled | 0.999835 |
| Cloud submission of the optimized pulse (EMU_FREE) | job completed ✓ |

Agreement solve↔translation: ~7e-07. Verdict: **translation of a
single-channel (Ω, Δ) pulse is trivial** when the solve is parameterized for
it — see the trick below.

The whole chain was also driven end-to-end through a live opencode (Amico)
chat session on 2026-07-08: the agent sequenced solve → translate → submit
itself, and authored `submit_optimized.py` from the two reference scripts
(adopted here after review).

## How to run

```bash
cd <scratch dir>
julia --project=$HOME/.amico/julia solve_x_gate.jl     # writes pulse.toml
python3 translate_and_simulate.py                       # validates + simulates
# optional cloud leg (Pasqal Explorer credentials, env vars only):
PASQAL_USERNAME=... PASQAL_PASSWORD=... PASQAL_PROJECT_ID=... \
  python3 submit_optimized.py                           # submits to EMU_FREE
```

Python deps: `../requirements.txt` (pulser 1.8.0). Julia deps: the standard
amicode project (`~/.amico/julia`, provisioned by `install.sh`).

## The trick that makes translation an identity map

Parameterize the solve in Pulser's own terms. The Hamiltonian is built as

```
H(t) = u1(t)·σx/2 + u2(t)·(−|r⟩⟨r|)
```

which is exactly Pulser's `H = Ω σx/2 − Δ|r⟩⟨r|` at phase 0 — so `u1` IS Ω and
`u2` IS Δ, sign convention included. Bounds come straight off the device:
`Ω ∈ (0, max_amp)` (Piccolo supports asymmetric bounds — Pulser amplitude is
nonnegative), `Δ ∈ ±max_abs_detuning`, and `Δt_bounds = (4.0, 4.0)` pins knots
to the AnalogDevice clock grid so zero-order hold onto the 1 ns sample grid is
exact.

## Known limits (deliberately out of spike scope)

- **Constant phase per pulse.** Pulser's `Pulse` carries one phase; a
  two-quadrature (Ωx, Ωy) Piccolo solve needs either phase-segmented pulses or
  a single-quadrature re-parameterization (used here). Fine for single-channel
  gates; revisit for arbitrary-phase pulses.
- **Single atom.** Multi-atom registers (the blockade CZ) add register
  geometry, the global-channel constraint, and C6 physics — that's the next
  milestone, not a translation problem per se.
- **ZOH staircase.** The 8 MHz modulation check passed here, but harder/faster
  pulses may lose more; `InterpolatedWaveform` from the same knots is the
  smoother alternative if that starts to bite.
