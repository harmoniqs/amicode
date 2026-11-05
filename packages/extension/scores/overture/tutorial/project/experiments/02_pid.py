"""Loop 2 - PID: close the loop around the feedforward controls.

Same unicycle, same circle, same perturbed start as loop 1 - but now the
controller measures where the robot is and corrects it.  Two PID loops run on
top of the feedforward controls:

  * speed channel   - PID on the along-track error (how far ahead/behind the
                      reference point the robot is, measured in its own frame)
  * steering channel - PID on a blended error: heading error plus a multiple of
                      the cross-track error, so the robot steers back onto the path

The gains are deliberately aggressive.  The robot reaches the circle quickly,
carries too much momentum, shoots past it to the inside, and only then settles
back onto it - that overshoot is the point of the loop.  Loop 3 shows
how a model-based controller avoids it.

Deterministic, no randomness.  Needs only NumPy and Matplotlib.
Writes experiments/02_pid/{result.json, tracking_error.png}.
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
START = (RADIUS + 0.3, -0.2, math.pi / 2 - 0.4)  # the perturbed start from loop 1

# actuator range (the real robot saturates; PID does not know about it)
V_MIN, V_MAX = 0.0, 0.8  # m/s
OMEGA_MAX = 1.5  # rad/s

# ---- PID gains
KP_V, KI_V = 1.5, 0.2  # speed channel on along-track error
K_LAT = 2.0  # cross-track error -> heading demand [rad/m]
KP_W, KI_W, KD_W = 2.0, 2.0, 0.3  # steering channel
I_LIMIT = 1.0  # anti-windup clamp on both integrators

OUT_DIR = Path(__file__).resolve().parent / "02_pid"


def reference(k):
    """Reference pose (x, y, theta) at step k."""
    phase = OMEGA_REF * DT * k
    return RADIUS * math.cos(phase), RADIUS * math.sin(phase), phase + math.pi / 2


def wrap(angle):
    """Wrap an angle to (-pi, pi]."""
    return math.atan2(math.sin(angle), math.cos(angle))


def clip(value, lo, hi):
    return max(lo, min(hi, value))


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


def run_pid(start):
    state = start
    int_long = int_steer = 0.0
    prev_steer = None
    path, pos_err, radial_err = [], [], []
    for k in range(N_STEPS + 1):
        x, y, th = state
        rx, ry, rth = reference(k)
        path.append((x, y))
        pos_err.append(math.hypot(x - rx, y - ry))
        radial_err.append(math.hypot(x, y) - RADIUS)  # + outside the circle, - inside
        if k == N_STEPS:
            break

        # error in the robot's own frame: along its heading / to its left
        dx, dy = rx - x, ry - y
        e_long = math.cos(th) * dx + math.sin(th) * dy
        e_lat = -math.sin(th) * dx + math.cos(th) * dy
        e_steer = wrap(rth - th) + K_LAT * e_lat

        int_long = clip(int_long + e_long * DT, -I_LIMIT, I_LIMIT)
        int_steer = clip(int_steer + e_steer * DT, -I_LIMIT, I_LIMIT)
        d_steer = 0.0 if prev_steer is None else (e_steer - prev_steer) / DT
        prev_steer = e_steer

        v = V_REF + KP_V * e_long + KI_V * int_long
        omega = OMEGA_REF + KP_W * e_steer + KI_W * int_steer + KD_W * d_steer
        state = step(state, clip(v, V_MIN, V_MAX), clip(omega, -OMEGA_MAX, OMEGA_MAX))
    return path, pos_err, radial_err


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path, pos_err, radial_err = run_pid(START)

    settle = int(2.5 / DT)  # last 2.5 s
    metrics = {
        "initial_error_m": round(pos_err[0], 6),
        "max_error_m": round(max(pos_err), 6),
        "rms_error_m": round(math.sqrt(sum(e * e for e in pos_err) / len(pos_err)), 6),
        "final_error_m": round(sum(pos_err[-settle:]) / settle, 6),
        # how far the robot ends up on the *opposite* side of the circle
        # (inside) after starting outside it
        "overshoot_m": round(max(0.0, -min(radial_err)), 6),
    }
    result = {
        "loop": "02_pid",
        "controller": "PID on top of feedforward",
        "dt_s": DT,
        "n_steps": N_STEPS,
        "gains": {
            "kp_v": KP_V, "ki_v": KI_V, "k_lat": K_LAT,
            "kp_w": KP_W, "ki_w": KI_W, "kd_w": KD_W,
        },
        "metrics": metrics,
        "tracking_error_m": [round(e, 6) for e in pos_err],
        "radial_error_m": [round(e, 6) for e in radial_err],
    }
    (OUT_DIR / "result.json").write_text(json.dumps(result, indent=2) + "\n")

    t = DT * np.arange(N_STEPS + 1)
    ref = np.array([reference(k)[:2] for k in range(N_STEPS + 1)])
    fig, (ax_path, ax_err) = plt.subplots(1, 2, figsize=(10, 4.2))
    ax_path.plot(ref[:, 0], ref[:, 1], "k--", label="reference")
    ax_path.plot(*zip(*path), label="PID")
    ax_path.plot(*path[0], "ro", label="start")
    ax_path.set_aspect("equal")
    ax_path.set_xlabel("x [m]")
    ax_path.set_ylabel("y [m]")
    ax_path.set_title("PID path")
    ax_path.legend(loc="upper right", fontsize=8)
    ax_err.plot(t, pos_err, label="tracking error")
    ax_err.plot(t, radial_err, label="radial error (+ outside / - inside)")
    ax_err.axhline(0.0, color="k", lw=0.5)
    ax_err.set_xlabel("time [s]")
    ax_err.set_ylabel("error [m]")
    ax_err.set_title("PID tracking error and overshoot")
    ax_err.legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(OUT_DIR / "tracking_error.png", dpi=110)
    plt.close(fig)

    print(
        f"02_pid: final error {metrics['final_error_m']:.4f} m, "
        f"overshoot {metrics['overshoot_m']:.3f} m, rms {metrics['rms_error_m']:.3f} m"
    )


if __name__ == "__main__":
    main()
