#!/usr/bin/env python3
"""Gate-unitary emulation leg — ported from the campaign's validated
emulate_gate_unitary.py (session-20260924-pasqal-gate-autoresearch, h1 stage
3; validated to 1.2e-5 emulator-vs-Julia-:constant-rollout consistency, the
unitary machinery self-checked to ||U−exact||∞ = 1.6e-6).

pulse.toml -> pulse_contract.build_sequence (single source of truth) ->
QutipEmulator (pulser_simulation 1.8.0) -> Hamiltonian extracted from the
emulator's own objects (samples_obj waveforms + build_operator operators +
the QobjEvo's static interaction term) -> qutip.sesolve over the 4
computational basis kets with ORDER=0 (piecewise-constant) coefficients ->
U_emu (4x4) -> CZ fidelity, fixed-phase and free-phase, entirely in the
emulator's own r-first basis. No Julia-side matrices are imported.

WHY NOT emu.run() (S-10, found 2026-09-24):
  pulser_simulation 1.8.0 hands its sampled CustomWaveforms to qutip 5's
  QobjEvo, whose array-coefficient default is a CUBIC SPLINE (order=3), not
  the piecewise-constant staircase the pulse contract executes. On jagged
  device-native ZOH pulses (Delta up to +-125.66 rad/us between adjacent 4 ns
  knots) the splined waveform is a physically different pulse: emu.run()
  scored F_emu_free=0.5860 vs the Julia ZOH rollout F_free=0.4615 on the
  campaign's blockade-pi attempt (delta_consistency 0.125 >> 1e-3). Constant
  pulses (a plain X gate) are immune — cubic spline of a constant is the
  constant — which is exactly the trap: the smooth-pulse regression stays
  green while the gate leg is wrong. Fix: extract the Hamiltonian, rebuild it
  with coefficient(order=0), sesolve per basis ket.

  Known quirk (S-12, pulser_simulation 1.8.0 — upstream report candidate):
  emu.run() from a custom |rr> initial state returns exactly exp(+i*V*T)
  times the true final state; runs from |rg>, |gr>, |gg> are unaffected. This
  path does not use set_initial_state for the unitary at all (only for the
  recorded all-ground comparison column).

Trailing-zero restore (S-13): pulser's samples_obj appends one trailing zero
sample at t=T; for order=0 that would zero the final 1 ns. The contract plays
knots[:-1] for dt each, so the last-held value is samples[-2] — restored in
restore_trailing_zero_sample() below. For a genuinely idle-ending pulse
samples[-2] is already 0, so the restore is a no-op.

Basis facts (verified against the installed pulser at runtime):
- "ground-rydberg" basis: per-atom index 0 = |r>, 1 = |g>.
- CZ on {|g>,|r>}^2 flips the phase of |rr> -> in r-first ordering |rr> is
  global index 0, so CZ_emu = diag(-1, 1, 1, 1).
- D(theta) = Z(theta_1) (x) Z(theta_2) left-acting on the goal: virtual-Z
  gives |r> the phase e^{i theta}; in r-first ordering that is diag(e^{i th},
  1) per atom.

Free-phase grid+refinement mirrors the Julia leg's free_phase_fidelities:
49-point coarse grid over [-pi, pi]^2, then two refinement passes at step
and step/10 (11 points per axis per pass).

The modulated leg (with_modulation=True — the device's output-modulation
filter, i.e. the PHYSICS leg: the device truth is the filtered waveform) runs
after the unmodulated leg; any exception there is an OPS FAILURE (exit 1,
attempt not adjudicated), never a recorded-error-with-exit-0.

Usage: emulate_gate_unitary.py PULSE_TOML [--out RESULTS_JSON] [--modulation-only]
"""

import argparse
import json
import sys
import traceback
from pathlib import Path

import numpy as np
import qutip
from qutip.core.coefficient import coefficient
from pulser_simulation import QutipEmulator

from pulse_contract import build_sequence, load_knots

N_ATOMS = 2
DIM = 2 ** N_ATOMS
N_GRID = 49


def basis_kets():
    """The 4 computational basis kets as vectors in the emulator's r-first
    global basis (q0 = MSB). Index bits: bit=0 -> |r>, bit=1 -> |g>."""
    kets = np.zeros((DIM, DIM), dtype=complex)
    for i in range(DIM):
        kets[i, i] = 1.0
    return kets


def atom_bits(global_index: int):
    """Per-atom bit of a global basis index, q0 = MSB. bit 0 = |r>, 1 = |g>."""
    return [(global_index >> (N_ATOMS - 1 - j)) & 1 for j in range(N_ATOMS)]


def restore_trailing_zero_sample(amp, det, phase):
    """S-13: undo the trailing zero sample pulser's sampler appends at t=T.

    The contract's zero-order hold plays knots[:-1] for dt each — the final
    knot is never held — so the sampler's appended zero would integrate as a
    1-ns dead interval under order=0. The last-held value is samples[-2];
    restore it. For a genuinely idle-ending pulse samples[-2] is already 0
    and this is a no-op.
    """
    if len(amp) > 1 and amp[-1] == 0.0 and det[-1] == 0.0:
        return (
            np.append(amp[:-1], amp[-2]),
            np.append(det[:-1], det[-2]),
            np.append(phase[:-1], phase[-2]),
        )
    return amp, det, phase


def emulator_unitary_step(sequence, with_modulation: bool) -> tuple:
    """U_emu on the 4-dim computational space: rebuild the emulator's own
    Hamiltonian with order=0 (ZOH) coefficients and sesolve each basis ket
    with qutip (the emulator's own solver).

    Returns (U, allground_gap) where allground_gap compares this path's
    |gg> column against emu.run()'s all-ground final state (spline-integrated
    by pulser; the gap on a jagged pulse IS the S-10 spline artifact — it is
    recorded, and its size is the tripwire for upstream changing the
    default)."""
    emu = QutipEmulator.from_sequence(
        sequence, sampling_rate=1.0, with_modulation=with_modulation
    )
    ham = emu._current_hamiltonian

    # the emulator's own sampled waveforms (1 ns resolution, verified ==
    # the contract's ZOH staircase on the campaign's attempt (a))
    g = emu.samples_obj.to_nested_dict()["Global"]["ground-rydberg"]
    amp = np.asarray(g["amp"], dtype=float)
    det = np.asarray(g["det"], dtype=float)
    phase = np.asarray(g["phase"], dtype=float)
    tlist = np.asarray(ham.sampling_times, dtype=float)
    assert len(amp) == len(tlist), f"samples {len(amp)} vs tlist {len(tlist)}"

    amp, det, phase = restore_trailing_zero_sample(amp, det, phase)

    # the emulator's own operators (build_operator API) and its static
    # interaction term extracted from the final QobjEvo (post ham+ham.dag(),
    # i.e. already V*n1n2 — the compressed to_list carries the interaction as
    # a bare static Qobj; the drive terms there are already Hermitian-merged)
    terms = ham._hamiltonian.to_list()
    static = [t for t in terms if isinstance(t, qutip.Qobj)]
    assert len(static) == 1, f"expected 1 static (interaction) term, got {len(static)}"
    interaction = static[0]
    # sanity: the static term is the vdW interaction, |rr> diagonal == C6/d^6
    d = sequence.device
    coords = np.asarray(sequence.register._coords)
    dist = float(np.linalg.norm(coords[0] - coords[1]))
    v_expected = d.interaction_coeff / dist ** 6
    v_rr = float(np.asarray(interaction.full())[0, 0].real)
    assert abs(v_rr - v_expected) < 1e-6 * v_expected, \
        f"interaction mismatch: {v_rr} vs C6/d^6 = {v_expected}"
    op_gr = ham.build_operator([("sigma_gr", "global")])
    op_rr = ham.build_operator([("sigma_rr", "global")])

    # pulser's construction (hamiltonian.py, v1.8.0): drive coeff on sigma_gr
    # is 0.5*amp*e^{-i*phase}, det coeff on sigma_rr is -0.5*det; the final
    # H doubles those via ham + ham.dag(). Rebuild with order=0 coefficients.
    c_gr = coefficient(0.5 * amp * np.exp(-1j * phase), tlist=tlist, order=0)
    c_rr = coefficient(-0.5 * det, tlist=tlist, order=0)
    h_td = qutip.QobjEvo([[op_gr, c_gr], [op_rr, c_rr]])
    h_step = h_td + h_td.dag() + interaction
    h_step.compress()

    U = np.zeros((DIM, DIM), dtype=complex)
    for i in range(DIM):
        psi = qutip.Qobj(basis_kets()[i], dims=[[2] * N_ATOMS, [1] * N_ATOMS])
        out = qutip.sesolve(
            h_step, psi, tlist,
            options={"normalize_output": False, "nsteps": 100000,
                     "atol": 1e-10, "rtol": 1e-10},
        )
        U[:, i] = np.asarray(out.states[-1].full()).flatten()

    # all-ground reference from pulser's own run() (spline-integrated; on a
    # jagged pulse the gap vs this path is the spline artifact — recorded)
    emu.set_initial_state("all-ground")
    gg_run = np.asarray(emu.run().get_final_state().full()).flatten()
    gg_gap = float(np.linalg.norm(U[:, DIM - 1] - gg_run))
    return U, gg_gap


def phase_matrix(theta1: float, theta2: float) -> np.ndarray:
    """D(theta) = Z(t1) (x) Z(t2) in the r-first global basis: atom in |r>
    (bit 0) picks up e^{i theta_j}."""
    diag = np.ones(DIM, dtype=complex)
    for i in range(DIM):
        bits = atom_bits(i)
        for j, b in enumerate(bits):
            if b == 0:
                diag[i] *= np.exp(1j * (theta1 if j == 0 else theta2))
    return np.diag(diag)


# |rr> is global index 0 in the r-first basis -> CZ_emu = diag(-1, 1, 1, 1)
CZ_EMU = np.diag([-1.0, 1.0, 1.0, 1.0]).astype(complex)

# SWAP symmetry check matrix (swaps |gr> <-> |rg>, indices 1 and 2)
SWAP = np.eye(DIM, dtype=complex)[[0, 2, 1, 3]]


def fidelity(U: np.ndarray, theta1: float, theta2: float) -> float:
    return float(np.abs(np.trace(U.conj().T @ phase_matrix(theta1, theta2) @ CZ_EMU)) ** 2 / DIM ** 2)


def free_phase_fidelities(U: np.ndarray):
    """max_theta |tr(U^dag D(theta) CZ)|^2 / 16 — same grid+refinement as the
    Julia leg (free_phase_fidelities idiom, 2D)."""
    grid = np.linspace(-np.pi, np.pi, N_GRID)
    best_f, best_th = 0.0, (0.0, 0.0)
    for t1 in grid:
        for t2 in grid:
            f = fidelity(U, t1, t2)
            if f > best_f:
                best_f, best_th = f, (t1, t2)
    step = 2 * np.pi / (N_GRID - 1)
    for delta in (step, step / 10):
        t1s = np.linspace(best_th[0] - 5 * delta, best_th[0] + 5 * delta, 11)
        t2s = np.linspace(best_th[1] - 5 * delta, best_th[1] + 5 * delta, 11)
        for t1 in t1s:
            for t2 in t2s:
                f = fidelity(U, t1, t2)
                if f > best_f:
                    best_f, best_th = f, (t1, t2)
    return fidelity(U, 0.0, 0.0), best_f, [float(t) for t in best_th]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("pulse_toml")
    ap.add_argument("--out", default=None, help="write results JSON here")
    args = ap.parse_args()

    data = load_knots(args.pulse_toml)          # contract validation (schema)
    sequence = build_sequence(data)             # device validation + build
    print(f"Validated: {data['n_knots']} knots dt={data['dt_ns']}ns, "
          f"atoms={data.get('atoms')}, duration {sequence.get_duration()}ns")

    U, gg_gap = emulator_unitary_step(sequence, with_modulation=False)
    unitarity = float(np.linalg.norm(U.conj().T @ U - np.eye(DIM), np.inf))
    swap_gap = float(np.linalg.norm(U - SWAP @ U @ SWAP, np.inf))
    f_fixed, f_free, theta_star = free_phase_fidelities(U)

    print(f"U_emu via order=0 ZOH leg: emulator-extracted H (samples_obj + "
          f"build_operator + QobjEvo static term), coefficient(order=0), "
          f"qutip.sesolve per basis ket")
    print(f"  unitarity ||U'U - I||inf = {unitarity:.3e}")
    print(f"  swap-symmetry gap = {swap_gap:.3e}")
    print(f"  |gg> column vs emu.run() all-ground (spline) gap = {gg_gap:.3e} "
          f"(the S-10 spline artifact on a jagged pulse)")
    print(f"F_emu_fixed = {f_fixed:.8f}")
    print(f"F_emu_free  = {f_free:.8f}  at theta* = ({theta_star[0]:.6f}, {theta_star[1]:.6f})")

    results = {
        "pulse": str(Path(args.pulse_toml).resolve()),
        "emulator": "order=0 ZOH leg: emulator-extracted Hamiltonian "
                    "(samples_obj waveforms, build_operator ops, QobjEvo "
                    "static interaction), qutip coefficient(order=0), "
                    "qutip.sesolve per basis ket; sampling_rate=1.0, "
                    "with_modulation=False",
        "F_emu_fixed": f_fixed,
        "F_emu_free": f_free,
        "theta_star": theta_star,
        "unitarity_gap_inf": unitarity,
        "swap_symmetry_gap": swap_gap,
        "allground_vs_ggcol_gap": gg_gap,
    }

    # Modulated leg — the PHYSICS leg (the device truth is the filtered
    # waveform). Any exception here is an OPS FAILURE (attempt NOT
    # adjudicated), never a recorded-error-with-exit-0: the results JSON is
    # written for the record first, then a non-zero exit.
    try:
        Um, gg_gap_m = emulator_unitary_step(sequence, with_modulation=True)
        f_fixed_m, f_free_m, theta_m = free_phase_fidelities(Um)
        results["with_modulation"] = {
            "F_emu_fixed": f_fixed_m,
            "F_emu_free": f_free_m,
            "theta_star": theta_m,
            "allground_vs_ggcol_gap": gg_gap_m,
        }
        print(f"modulation-on: F_emu_fixed = {f_fixed_m:.8f}  "
              f"F_emu_free = {f_free_m:.8f} (the physics leg: what the "
              "device, with its output-modulation filter, actually plays)")
    except Exception as exc:  # noqa: BLE001 - record, then HALT (ops failure)
        results["with_modulation"] = {"error": repr(exc)}
        if args.out:
            Path(args.out).write_text(json.dumps(results, indent=2) + "\n")
        print(f"MODULATED-LEG OPS FAILURE (attempt NOT adjudicated): {exc!r}",
              file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)

    if args.out:
        Path(args.out).write_text(json.dumps(results, indent=2) + "\n")
        print(f"wrote {args.out}")


if __name__ == "__main__":
    main()