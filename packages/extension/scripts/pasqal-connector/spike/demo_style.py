"""Shared visual language for the Pasqal demo figures.

One place for every styling decision, so the three demo scripts read as one
system. Grounded in two passes: the dataviz six-checks (the categorical pair
below validated against the light surface — CVD ΔE 73) and a ui-ux-pro-max
pass (technical grotesque typography, editorial title/subtitle, whitespace,
precision-minimal restraint; its neon-dark suggestion was rejected — these
are light-surface presentation figures).

Also owns the register and waveform renderers that replace Pulser's default
draws, so atom-position figures share the same language as the charts.
"""

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Circle

# ── Palettes (both validated via the dataviz six-checks on their surface) ──
# Light surface #fcfcfb; dark surface #131010 (the app's dark theme-color).
LIGHT = {
    "name": "light", "BLUE": "#2F5DA8", "RUST": "#B15C39",
    "SURFACE": "#fcfcfb", "INK": "#26251f", "INK_MUTED": "#767470",
    "INK_FAINT": "#a8a6a0", "GRID": "#ecebe7",
}
DARK = {
    "name": "dark", "BLUE": "#5E8FD8", "RUST": "#C97F4E",
    "SURFACE": "#131010", "INK": "#e8e6e1", "INK_MUTED": "#9a9792",
    "INK_FAINT": "#6b6863", "GRID": "#2a2825",
}
THEMES = (LIGHT, DARK)

# Mutable current theme — these one-shot scripts render each figure once per
# theme via use(); module-level names keep the call sites readable.
BLUE = LIGHT["BLUE"]; RUST = LIGHT["RUST"]; SURFACE = LIGHT["SURFACE"]
INK = LIGHT["INK"]; INK_MUTED = LIGHT["INK_MUTED"]
INK_FAINT = LIGHT["INK_FAINT"]; GRID = LIGHT["GRID"]
_CURRENT = LIGHT

FONT = "Helvetica Neue"
MONO = "Menlo"

matplotlib.rcParams.update({"font.family": FONT, "savefig.dpi": 170,
                            "xtick.labelsize": 9, "ytick.labelsize": 9})


def use(theme: dict) -> None:
    """Switch the active theme; figures built afterwards pick it up."""
    global BLUE, RUST, SURFACE, INK, INK_MUTED, INK_FAINT, GRID, _CURRENT
    _CURRENT = theme
    BLUE, RUST, SURFACE = theme["BLUE"], theme["RUST"], theme["SURFACE"]
    INK, INK_MUTED = theme["INK"], theme["INK_MUTED"]
    INK_FAINT, GRID = theme["INK_FAINT"], theme["GRID"]
    matplotlib.rcParams.update({
        "figure.facecolor": SURFACE, "axes.facecolor": SURFACE,
        "savefig.facecolor": SURFACE, "axes.edgecolor": GRID,
        "text.color": INK, "axes.labelcolor": INK_MUTED,
        "xtick.color": INK_MUTED, "ytick.color": INK_MUTED,
    })


use(LIGHT)


def out(filename: str) -> str:
    """Theme-variant filename: foo.png (light) / foo.dark.png (dark)."""
    if _CURRENT["name"] == "dark" and filename.endswith(".png"):
        return filename[: -len(".png")] + ".dark.png"
    return filename


def render_both(build, filename: str) -> None:
    """Build and save a figure once per theme. `build` returns a Figure."""
    for theme in THEMES:
        use(theme)
        fig = build()
        fig.savefig(out(filename))
        plt.close(fig)
    use(LIGHT)


def figure(width=8.2, height=5.0):
    fig, ax = plt.subplots(figsize=(width, height), dpi=170)
    fig.patch.set_facecolor(SURFACE)
    ax.set_facecolor(SURFACE)
    return fig, ax


def headline(fig, title: str, subtitle: str) -> None:
    """Editorial left-aligned title + muted subtitle, generous air below."""
    fig.text(0.06, 0.945, title, fontsize=14, fontweight=600, color=INK, ha="left")
    fig.text(0.06, 0.895, subtitle, fontsize=9.5, color=INK_MUTED, ha="left")


def footer(fig, note: str = "Piccolo × Pulser · closed-system simulation") -> None:
    fig.text(0.06, 0.022, note, fontsize=7.5, color=INK_FAINT, ha="left")


def polish(ax, ygrid_only: bool = True) -> None:
    for spine in ax.spines.values():
        spine.set_visible(False)
    ax.grid(True, axis="y" if ygrid_only else "both", color=GRID, lw=0.7)
    ax.tick_params(length=0)


def series(ax, xs, ys, color, label=None, marker=True) -> None:
    """2px line, 7px markers with a white surface ring (dataviz mark spec)."""
    ax.plot(xs, ys, color=color, lw=2, zorder=3,
            marker="o" if marker else None, ms=6.5,
            markerfacecolor=color, markeredgecolor=SURFACE, markeredgewidth=1.4)
    if label:
        ax.annotate(label, xy=(xs[-1], ys[-1]), xytext=(7, 0),
                    textcoords="offset points", fontsize=9.5, color=color,
                    fontweight=550, va="center")


def draw_register(atoms, filename: str, title: str, subtitle: str,
                  blockade_radius: float, broken_pairs=(), pair_labels=True) -> None:
    """Cohesive register figure, rendered once per theme (light + dark)."""
    render_both(
        lambda: _register_figure(atoms, title, subtitle, blockade_radius,
                                 broken_pairs, pair_labels),
        filename,
    )


def _register_figure(atoms, title, subtitle, blockade_radius, broken_pairs, pair_labels):
    atoms = [tuple(a) for a in atoms]
    fig, ax = figure(6.4, 5.4)

    for x, y in atoms:
        ax.add_patch(Circle((x, y), blockade_radius / 2, facecolor=BLUE,
                            alpha=0.07, edgecolor=BLUE, lw=0.8,
                            linestyle=(0, (4, 3)), zorder=1))

    n = len(atoms)
    for i in range(n):
        for j in range(i + 1, n):
            (x1, y1), (x2, y2) = atoms[i], atoms[j]
            dist = float(np.hypot(x2 - x1, y2 - y1))
            broken = (i, j) in broken_pairs or (j, i) in broken_pairs
            if broken:
                # Bow broken links out as a dashed arc so they never hide
                # under solid links when atoms are collinear (chains).
                ax.annotate("", xy=(x2, y2), xytext=(x1, y1), zorder=2,
                            arrowprops={"arrowstyle": "-", "color": RUST,
                                        "lw": 1.2, "linestyle": (0, (5, 4)),
                                        "connectionstyle": "arc3,rad=0.35",
                                        "shrinkA": 4, "shrinkB": 4})
            else:
                ax.plot([x1, x2], [y1, y2], color=INK_FAINT, lw=1.2, zorder=2)
            if pair_labels:
                mx, my = (x1 + x2) / 2, (y1 + y2) / 2
                if broken:
                    # label at the arc's apex, pushed further out
                    sag = 0.35 * dist / 2
                    ax.annotate(f"{dist:g} µm — not blockaded", xy=(mx, my - sag),
                                xytext=(0, -14), textcoords="offset points",
                                ha="center", fontsize=8.5, color=RUST, family=MONO)
                else:
                    ax.annotate(f"{dist:g} µm", xy=(mx, my), xytext=(0, 7),
                                textcoords="offset points", ha="center",
                                fontsize=8.5, color=INK_MUTED, family=MONO)

    for k, (x, y) in enumerate(atoms):
        ax.add_patch(Circle((x, y), 0.28, facecolor=INK, edgecolor=SURFACE,
                            lw=1.6, zorder=4))
        ax.annotate(f"q{k}", xy=(x, y), xytext=(0, -16),
                    textcoords="offset points", ha="center", fontsize=9,
                    color=INK, family=MONO, zorder=4)

    xs = [a[0] for a in atoms]; ys = [a[1] for a in atoms]
    pad = blockade_radius / 2 + 1.5
    ax.set_xlim(min(xs) - pad, max(xs) + pad)
    ax.set_ylim(min(ys) - pad, max(ys) + pad)
    ax.set_aspect("equal")
    ax.set_xlabel("x (µm)", fontsize=9)
    ax.set_ylabel("y (µm)", fontsize=9)
    polish(ax, ygrid_only=False)
    headline(fig, title, subtitle)
    footer(fig, "blockade disks drawn at r_b/2 — overlapping disks mean the pair is blockaded")
    fig.subplots_adjust(top=0.84, bottom=0.15, left=0.1, right=0.96)
    return fig


def draw_waveforms(data: dict, filename: str, title: str, subtitle: str) -> None:
    """Ω/Δ ZOH waveform figure, rendered once per theme (light + dark)."""
    render_both(lambda: _waveform_figure(data, title, subtitle), filename)


def _waveform_figure(data, title, subtitle):
    n = data["n_knots"]; dt = data["dt_ns"]
    t = np.arange(n) * dt
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(8.2, 4.6), dpi=170,
                                   sharex=True, height_ratios=[1, 1])
    fig.patch.set_facecolor(SURFACE)
    for ax, values, color, label in (
        (ax1, data["amplitude"], BLUE, "Ω amplitude (rad/µs)"),
        (ax2, data["detuning"], RUST, "Δ detuning (rad/µs)"),
    ):
        ax.set_facecolor(SURFACE)
        ax.step(t, values, where="post", color=color, lw=1.8, zorder=3)
        ax.fill_between(t, values, step="post", color=color, alpha=0.10, zorder=2)
        ax.axhline(0, color=INK_FAINT, lw=0.7, zorder=1)
        ax.set_ylabel(label, fontsize=9)
        polish(ax)
    ax2.set_xlabel("t (ns)", fontsize=9)
    headline(fig, title, subtitle)
    footer(fig)
    fig.subplots_adjust(top=0.82, bottom=0.13, left=0.1, right=0.96, hspace=0.18)
    return fig
