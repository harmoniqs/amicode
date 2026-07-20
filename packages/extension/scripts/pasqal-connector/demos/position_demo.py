#!/usr/bin/env python3
"""Pasqal demo: atom-position optimization for Bell-state preparation.

Two subcommands, both local (no credentials, no network):

  sweep [pulse_dir]   Fidelity-vs-spacing study. For each spacing: the naive
                      blockade-π protocol simulated in QuTiP, and — where a
                      Piccolo-solved pulse_bell_d<d>.toml exists in pulse_dir
                      (default .) — the optimized pulse, re-verified
                      independently in the same emulator. Writes
                      position_sweep.png + prints a table.

  visuals <pulse.toml>  Register plot (atom positions + blockade radius) and
                      pulse waveform plot for one solved pulse. Writes
                      register.png + sequence.png.

The physics: V = C6/d^6. At AnalogDevice's 5 µm minimum spacing V/Ω ≈ 4.9
(moderate blockade) — the regime where pulse shaping earns its keep.
"""

import glob
import re
import sys
from pathlib import Path

import demo_style as style
import numpy as np
import pulser
from pulser_simulation import QutipEmulator

from pulse_contract import build_sequence, load_knots

DEVICE = pulser.AnalogDevice
CHANNEL = DEVICE.channels["rydberg_global"]

BELL = np.zeros(4, complex)
BELL[1] = BELL[2] = 1 / np.sqrt(2)  # (|gr⟩+|rg⟩)/√2; basis (rr, rg, gr, gg)


def bell_fidelity(sequence) -> float:
    state = QutipEmulator.from_sequence(sequence).run().get_final_state()
    return float(abs(np.vdot(BELL, state.full().flatten())) ** 2)


def naive_sequence(spacing_um: float, omega_frac: float = 0.9):
    """The textbook protocol: constant resonant pulse, π area on the
    blockade-enhanced (√2·Ω) transition."""
    omega = omega_frac * CHANNEL.max_amp
    duration = max(16, int(round(np.pi / (np.sqrt(2) * omega) * 1000 / 4)) * 4)
    register = pulser.Register.from_coordinates([(0, 0), (spacing_um, 0)], prefix="q")
    seq = pulser.Sequence(register, DEVICE)
    seq.declare_channel("rydberg_global", "rydberg_global")
    seq.add(pulser.Pulse.ConstantPulse(duration, omega, 0.0, 0.0), "rydberg_global")
    seq.measure()
    return seq


def spacing_of(path: str) -> float:
    match = re.search(r"pulse_bell_d([\d.]+)\.toml$", path)
    return float(match.group(1).rstrip(".")) if match else float("nan")


def sweep(pulse_dir: str = ".") -> None:
    spacings = [5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0]
    naive = [(d, bell_fidelity(naive_sequence(d))) for d in spacings]

    optimized = []
    for path in sorted(glob.glob(str(Path(pulse_dir) / "pulse_bell_d*.toml"))):
        data = load_knots(path)
        fid = bell_fidelity(build_sequence(data))
        optimized.append((spacing_of(path), fid, data.get("fidelity", float("nan"))))

    print(f"{'d (µm)':>7}  {'V/Ω':>6}  {'naive':>8}  {'optimized':>9}  {'solve':>8}")
    opt_by_d = {d: (f, s) for d, f, s in optimized}
    for d, nf in naive:
        ratio = DEVICE.interaction_coeff / d**6 / CHANNEL.max_amp
        of, sf = opt_by_d.get(d, (None, None))
        opt_col = f"{of:9.4f}" if of is not None else f"{'—':>9}"
        solve_col = f"{sf:8.4f}" if sf is not None else ""
        print(f"{d:7.1f}  {ratio:6.2f}  {nf:8.4f}  {opt_col}  {solve_col}")

    def build():
        fig, ax = style.figure()

        # Blockade-regime context bands (annotation, not a second axis)
        ax.axvspan(5.0, 5.9, color=style.BLUE, alpha=0.045, lw=0)
        ax.text(5.42, 0.315, "moderate blockade", fontsize=8.5, color=style.INK_MUTED, ha="center")
        ax.text(7.55, 0.315, "blockade too weak", fontsize=8.5, color=style.INK_MUTED, ha="center")

        nx, ny = zip(*naive)
        style.series(ax, nx, ny, style.RUST, label="naive π")
        if optimized:
            pts = sorted((d, f) for d, f, _ in optimized)
            ox, oy = zip(*pts)
            style.series(ax, ox, oy, style.BLUE, label="optimized")
            best_d, best_f = max(pts, key=lambda p: (round(p[1], 6), -p[0]))
            infid = max(1 - best_f, 1e-9)
            style.ring(ax, best_d, best_f)
            style.hero_stat(fig, f"1 − F = {infid:.1e}",
                            f"best position · {best_d:g} µm")

        ax.set_xlabel("atom spacing d (µm)", fontsize=9, color=style.INK_FAINT)
        ax.set_xlim(4.8, 8.7)
        ax.set_ylim(0.26, 1.06)
        ax.axhline(1.0, color=style.GRID, lw=0.8, zorder=1)
        style.declutter(ax, xticks=[5, 6, 7, 8], yticks=[0.4, 0.6, 0.8, 1.0])
        style.headline(fig, "Atom positioning matters",
                       "Bell-state prep on AnalogDevice — naive π vs optimized, 200 ns budget")
        style.footer(fig)
        fig.subplots_adjust(top=0.84, bottom=0.11, left=0.09, right=0.94)

        return fig

    style.render_both(build, "position_sweep.png")
    print("\nwrote position_sweep.png")
    print("AMICODE_IMAGE: position_sweep.png")


def visuals(pulse_path: str) -> None:
    data = load_knots(pulse_path)
    build_sequence(data)  # contract validation before we draw anything

    omega_peak = max(data["amplitude"])
    radius = DEVICE.rydberg_blockade_radius(omega_peak)
    atoms = data.get("atoms", [[0.0, 0.0]])
    spacing = data.get("atoms", [[0, 0], [5, 0]])
    d = abs(spacing[-1][0] - spacing[0][0]) if len(atoms) > 1 else 0.0
    style.draw_register(
        atoms, "register.png", "The register",
        f"two atoms at {d:g} µm — blockade radius {radius:.1f} µm at Ω_peak",
        radius,
    )
    style.draw_waveforms(
        data, "sequence_pulses.png", "The optimized pulse",
        f"global rydberg channel — {data['n_knots']} knots on the {data['dt_ns']:g} ns clock, "
        f"solve 1 − F = {max(1 - data.get('fidelity', 0), 1e-9):.1e}",
    )
    print(f"wrote register.png (blockade radius {radius:.2f} µm) and sequence_pulses.png")
    print("AMICODE_IMAGE: register.png")
    print("AMICODE_IMAGE: sequence_pulses.png")


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "visuals":
        visuals(sys.argv[2] if len(sys.argv) > 2 else "pulse_bell_d5.0.toml")
    else:
        sweep(sys.argv[2] if len(sys.argv) > 2 else ".")
