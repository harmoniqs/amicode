#!/usr/bin/env python3
"""Pasqal demos 2 & 3: multi-qubit atom-positioning studies (local, no creds).

  w-geometry [dir]   Demo 2 — geometry is the program. W-state on an
                     equilateral triangle vs a chain (both 5 µm sides): the
                     triangle blockades all three pairs, the chain leaves its
                     ends unprotected (10 µm). Same global-drive hardware,
                     same optimizer — the register decides. Uses
                     pulse_w_triangle.toml / pulse_w_chain.toml if present.
                     Writes register_triangle.png, register_chain.png.

  packing [dir]      Demo 3 — packing parallel entangling operations. Two
                     Bell pairs (5 µm wide) separated by gap L, one global
                     pulse. Baseline: the 2-atom optimized pulse
                     (pulse_bell_d5.0.toml) applied naively at each L.
                     Overlay: crosstalk-aware re-optimized pulses
                     (pulse_pairs_L<L>.toml) where solved. Writes
                     pair_packing.png + register_pairs.png.

All fidelities are computed in Pulser's QuTiP emulator — independent of the
solver that produced the pulses.
"""

import copy
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

COLOR_OPTIMIZED = "#2F5DA8"
COLOR_NAIVE = "#B15C39"
SURFACE = "#fcfcfb"
INK = "#333333"
INK_MUTED = "#767676"

SIDE = 5.0
TRIANGLE = [[0.0, 0.0], [SIDE, 0.0], [SIDE / 2, SIDE * np.sqrt(3) / 2]]
CHAIN = [[0.0, 0.0], [SIDE, 0.0], [2 * SIDE, 0.0]]


def final_state(sequence) -> np.ndarray:
    return QutipEmulator.from_sequence(sequence).run().get_final_state().full().flatten()


def w_target(n_atoms: int = 3) -> np.ndarray:
    """W = equal single-excitation superposition. Pulser basis: per atom
    index 0 = |r⟩, so |g…r…g⟩ has a 0-bit at the excited atom."""
    dim = 2**n_atoms
    target = np.zeros(dim, complex)
    all_g = dim - 1
    for atom in range(n_atoms):
        target[all_g & ~(1 << (n_atoms - 1 - atom))] = 1 / np.sqrt(n_atoms)
    return target


def bell_x_bell_target() -> np.ndarray:
    bell = np.zeros(4, complex)
    bell[1] = bell[2] = 1 / np.sqrt(2)  # (|gr⟩+|rg⟩)/√2 in (rr, rg, gr, gg)
    return np.kron(bell, bell)


def naive_sequence(atoms, enhancement: float, omega_frac: float = 0.9):
    """Constant resonant pulse, π area on the √n-enhanced collective line."""
    omega = omega_frac * CHANNEL.max_amp
    duration = max(16, int(round(np.pi / (enhancement * omega) * 1000 / 4)) * 4)
    register = pulser.Register.from_coordinates([tuple(a) for a in atoms], prefix="q")
    seq = pulser.Sequence(register, DEVICE)
    seq.declare_channel("rydberg_global", "rydberg_global")
    seq.add(pulser.Pulse.ConstantPulse(duration, omega, 0.0, 0.0), "rydberg_global")
    seq.measure()
    return seq


def draw_register(atoms, filename: str, title: str) -> None:
    register = pulser.Register.from_coordinates([tuple(a) for a in atoms], prefix="q")
    radius = DEVICE.rydberg_blockade_radius(0.9 * CHANNEL.max_amp)
    register.draw(blockade_radius=radius, draw_half_radius=True, draw_graph=True, show=False)
    plt.gcf().suptitle(title, fontsize=10)
    plt.savefig(filename, dpi=160, bbox_inches="tight")
    plt.close("all")


def w_geometry(pulse_dir: str = ".") -> None:
    target = w_target()
    print(f"{'geometry':>10}  {'naive':>8}  {'optimized':>9}  {'solve':>8}")
    for name, atoms in (("triangle", TRIANGLE), ("chain", CHAIN)):
        f_naive = abs(np.vdot(target, final_state(naive_sequence(atoms, np.sqrt(3))))) ** 2
        path = Path(pulse_dir) / f"pulse_w_{name}.toml"
        if path.exists():
            data = load_knots(str(path))
            f_opt = abs(np.vdot(target, final_state(build_sequence(data)))) ** 2
            print(f"{name:>10}  {f_naive:8.4f}  {f_opt:9.4f}  {data.get('fidelity', float('nan')):8.4f}")
        else:
            print(f"{name:>10}  {f_naive:8.4f}  {'—':>9}")
        draw_register(atoms, f"register_{name}.png",
                      f"{name} — all pairs blockaded" if name == "triangle"
                      else f"{name} — 10 µm ends NOT blockaded")
    print("\nwrote register_triangle.png, register_chain.png")


def packing(pulse_dir: str = ".") -> None:
    base = load_knots(str(Path(pulse_dir) / "pulse_bell_d5.0.toml"))
    target = bell_x_bell_target()

    def four_atom(data: dict, gap: float) -> dict:
        out = copy.deepcopy(data)
        out["atoms"] = [[0.0, 0.0], [SIDE, 0.0], [0.0, gap], [SIDE, gap]]
        return out

    gaps = [6.0, 7.0, 8.0, 10.0, 12.0, 15.0, 20.0]
    baseline = []
    for gap in gaps:
        fid = abs(np.vdot(target, final_state(build_sequence(four_atom(base, gap))))) ** 2
        baseline.append((gap, fid))

    reopt = []
    for path in sorted(glob.glob(str(Path(pulse_dir) / "pulse_pairs_L*.toml"))):
        data = load_knots(path)
        fid = abs(np.vdot(target, final_state(build_sequence(data)))) ** 2
        gap = float(re.search(r"L([\d.]+)\.toml$", path).group(1).rstrip("."))
        reopt.append((gap, fid, data.get("fidelity", float("nan"))))

    print(f"{'gap L (µm)':>10}  {'2-atom pulse':>12}  {'crosstalk-aware':>15}  {'solve':>8}")
    re_by_gap = {g: (f, s) for g, f, s in reopt}
    for gap, fid in baseline:
        of, sf = re_by_gap.get(gap, (None, None))
        opt_col = f"{of:15.4f}" if of is not None else f"{'—':>15}"
        solve_col = f"{sf:8.4f}" if sf is not None else ""
        print(f"{gap:10.1f}  {fid:12.4f}  {opt_col}  {solve_col}")

    fig, ax = plt.subplots(figsize=(8, 5), dpi=160)
    fig.patch.set_facecolor(SURFACE)
    ax.set_facecolor(SURFACE)
    ax.plot(*zip(*baseline), color=COLOR_NAIVE, lw=2, marker="o", ms=6,
            label="2-atom pulse reused (crosstalk-blind)")
    if reopt:
        pts = sorted((g, f) for g, f, _ in reopt)
        ax.plot(*zip(*pts), color=COLOR_OPTIMIZED, lw=0, marker="*", ms=16,
                label="crosstalk-aware re-optimized")
    ax.set_xlabel("inter-pair gap L (µm)", color=INK)
    ax.set_ylabel("fidelity to |Bell⟩⊗|Bell⟩", color=INK)
    ax.set_title("How densely can you pack parallel entangling operations?",
                 color=INK, fontsize=11.5, pad=12)
    ax.grid(True, color="#e6e6e3", lw=0.7)
    ax.tick_params(colors=INK_MUTED)
    for spine in ax.spines.values():
        spine.set_visible(False)
    ax.legend(frameon=False, loc="lower right", fontsize=9)
    fig.tight_layout()
    fig.savefig("pair_packing.png", facecolor=SURFACE)

    tight = min((g for g, _, _ in reopt), default=6.0)
    draw_register([[0.0, 0.0], [SIDE, 0.0], [0.0, tight], [SIDE, tight]],
                  "register_pairs.png", f"Two Bell pairs, gap L = {tight:g} µm")
    print("\nwrote pair_packing.png, register_pairs.png")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "w-geometry"
    directory = sys.argv[2] if len(sys.argv) > 2 else "."
    if cmd == "packing":
        packing(directory)
    else:
        w_geometry(directory)
