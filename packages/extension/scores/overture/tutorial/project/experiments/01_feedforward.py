"""Loop 1 - feedforward: replay the reference controls, open loop.

A unicycle (position x, y and heading theta; controls: forward speed v and turn
rate omega) is asked to drive once around a circle of radius 1 m.  The
feedforward controller just plays back the controls that *would* trace the
circle exactly - it never looks at where the robot actually is.

Two starts are simulated:
  * matched   - the robot begins exactly on the reference: open loop tracks.
  * perturbed - the robot begins a little off: open loop cannot notice, so the
                error never goes away.

Deterministic, no randomness.  Needs only NumPy and Matplotlib.
Writes experiments/01_feedforward/{result.json, tracking_error.png}.
"""

import json
import math
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # headless: write files, never open a window
import matplotlib.pyplot as plt
import numpy as np

# ---- problem constants (inlined on purpose: every tutorial script is self-contained)
DT = 0.05  # s, control period
N_STEPS = 250  # 12.5 s, about one lap
RADIUS = 1.0  # m, reference circle centred on the origin
OMEGA_REF = 0.5  # rad/s, reference turn rate
V_REF = RADIUS * OMEGA_REF  # m/s, reference forward speed
MATCHED_START = (RADIUS, 0.0, math.pi / 2)  # exactly on the reference at t = 0
PERTURBED_START = (RADIUS + 0.3, -0.2, math.pi / 2 - 0.4)  # off by 0.3 m, 0.2 m, 0.4 rad

OUT_DIR = Path(__file__).resolve().parent / "01_feedforward"


def reference(k):
    """Reference pose (x, y, theta) at step k."""
    phase = OMEGA_REF * DT * k
    return RADIUS * math.cos(phase), RADIUS * math.sin(phase), phase + math.pi / 2


def step(state, v, omega):
    """Advance the unicycle one control period (exact for constant v, omega)."""
    x, y, th = state
    if abs(omega) < 1e-9:
        return x + v * DT * math.cos(th), y + v * DT * math.sin(th), th
    th_new = th + omega * DT
    return (
        x + v / omega * (math.sin(th_new) - math.sin(th)),
        y - v / omega * (math.cos(th_new) - math.cos(th)),
        th_new,
    )


def run_open_loop(start):
    """Play the reference controls back from `start`; return (path, errors)."""
    state = start
    path, errors = [], []
    for k in range(N_STEPS + 1):
        rx, ry, _ = reference(k)
        path.append((state[0], state[1]))
        errors.append(math.hypot(state[0] - rx, state[1] - ry))
        if k < N_STEPS:
            state = step(state, V_REF, OMEGA_REF)  # feedforward: no feedback term
    return path, errors


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    matched_path, matched_err = run_open_loop(MATCHED_START)
    perturbed_path, perturbed_err = run_open_loop(PERTURBED_START)

    metrics = {
        "matched_max_error_m": round(max(matched_err), 6),
        "perturbed_max_error_m": round(max(perturbed_err), 6),
        "perturbed_final_error_m": round(perturbed_err[-1], 6),
    }
    result = {
        "loop": "01_feedforward",
        "controller": "open-loop feedforward",
        "dt_s": DT,
        "n_steps": N_STEPS,
        "metrics": metrics,
        "tracking_error_m": {
            "matched": [round(e, 6) for e in matched_err],
            "perturbed": [round(e, 6) for e in perturbed_err],
        },
    }
    (OUT_DIR / "result.json").write_text(json.dumps(result, indent=2) + "\n")

    t = DT * np.arange(N_STEPS + 1)
    ref = np.array([reference(k)[:2] for k in range(N_STEPS + 1)])
    fig, (ax_path, ax_err) = plt.subplots(1, 2, figsize=(10, 4.2))
    ax_path.plot(ref[:, 0], ref[:, 1], "k--", label="reference")
    ax_path.plot(*zip(*matched_path), label="matched start")
    ax_path.plot(*zip(*perturbed_path), label="perturbed start")
    ax_path.set_aspect("equal")
    ax_path.set_xlabel("x [m]")
    ax_path.set_ylabel("y [m]")
    ax_path.set_title("Open-loop path")
    ax_path.legend(loc="upper right", fontsize=8)
    ax_err.plot(t, matched_err, label="matched start")
    ax_err.plot(t, perturbed_err, label="perturbed start")
    ax_err.set_xlabel("time [s]")
    ax_err.set_ylabel("tracking error [m]")
    ax_err.set_title("Feedforward tracking error")
    ax_err.legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(OUT_DIR / "tracking_error.png", dpi=110)
    plt.close(fig)

    print(
        "01_feedforward: matched max error "
        f"{metrics['matched_max_error_m']:.2e} m, perturbed final error "
        f"{metrics['perturbed_final_error_m']:.3f} m"
    )


if __name__ == "__main__":
    main()
