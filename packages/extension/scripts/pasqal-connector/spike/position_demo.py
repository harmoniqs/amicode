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

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pulser
from pulser_simulation import QutipEmulator

from pulse_contract import build_sequence, load_knots

DEVICE = pulser.AnalogDevice
CHANNEL = DEVICE.channels["rydberg_global"]

# Categorical pair, validated (dataviz six checks, light surface):
COLOR_OPTIMIZED = "#2F5DA8"
COLOR_NAIVE = "#B15C39"
SURFACE = "#fcfcfb"
INK = "#333333"
INK_MUTED = "#767676"

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

    fig, ax = plt.subplots(figsize=(8, 5), dpi=160)
    fig.patch.set_facecolor(SURFACE)
    ax.set_facecolor(SURFACE)

    # Blockade-regime context bands (annotation, not a second axis)
    ax.axvspan(5.0, 5.9, color="#2F5DA8", alpha=0.05, lw=0)
    ax.text(5.42, 0.315, "moderate blockade", fontsize=8.5, color=INK_MUTED, ha="center")
    ax.text(7.55, 0.315, "blockade too weak", fontsize=8.5, color=INK_MUTED, ha="center")

    ax.plot(*zip(*naive), color=COLOR_NAIVE, lw=2, marker="o", ms=6,
            label="naive blockade-π protocol")
    if optimized:
        pts = sorted((d, f) for d, f, _ in optimized)
        ax.plot(*zip(*pts), color=COLOR_OPTIMIZED, lw=2, marker="o", ms=6,
                label="Piccolo-optimized pulse")
        # Best position: max fidelity, ties broken toward the SMALLEST spacing
        # (5.0 and 5.5 µm both re-simulate at ≈1 to float precision).
        best_d, best_f = max(pts, key=lambda p: (round(p[1], 6), -p[0]))
        infid = max(1 - best_f, 1e-9)
        ax.annotate(f"best position: {best_d:g} µm\n1 − F = {infid:.1e}",
                    xy=(best_d, best_f), xytext=(best_d + 0.12, 0.855),
                    fontsize=9, color=COLOR_OPTIMIZED,
                    arrowprops={"arrowstyle": "-", "color": COLOR_OPTIMIZED, "lw": 1})

    ax.set_xlabel("atom spacing d (µm)", color=INK)
    ax.set_ylabel("Bell-state fidelity  |⟨Φ|ψ⟩|²", color=INK)
    ax.set_title("Atom positioning matters — and pulse optimization moves the curve",
                 color=INK, fontsize=11.5, pad=12)
    ax.set_ylim(0.28, 1.03)
    ax.grid(True, color="#e6e6e3", lw=0.7)
    ax.tick_params(colors=INK_MUTED)
    for spine in ax.spines.values():
        spine.set_visible(False)
    ax.legend(frameon=False, loc="upper right", fontsize=9)
    fig.tight_layout()
    fig.savefig("position_sweep.png", facecolor=SURFACE)
    print("\nwrote position_sweep.png")


def visuals(pulse_path: str) -> None:
    data = load_knots(pulse_path)
    seq = build_sequence(data)

    # Register with blockade radius at the pulse's peak amplitude
    omega_peak = max(data["amplitude"])
    radius = DEVICE.rydberg_blockade_radius(omega_peak)
    seq.register.draw(
        blockade_radius=radius, draw_half_radius=True, draw_graph=True,
        show=False, custom_ax=None,
    )
    plt.gcf().suptitle(f"Register — blockade radius {radius:.1f} µm at Ω_peak", fontsize=10)
    plt.savefig("register.png", dpi=160, bbox_inches="tight")
    plt.close("all")

    seq.draw(mode="input", fig_name="sequence.png", show=False)
    plt.close("all")
    print(f"wrote register.png (blockade radius {radius:.2f} µm) and sequence.png")


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "visuals":
        visuals(sys.argv[2] if len(sys.argv) > 2 else "pulse_bell_d5.0.toml")
    else:
        sweep(sys.argv[2] if len(sys.argv) > 2 else ".")
