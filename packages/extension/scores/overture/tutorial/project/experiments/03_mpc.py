"""Loop 3 - MPC: plan ahead, respect the limits.

Same unicycle, same circle, same perturbed start as loops 1 and 2.  At every
control step the controller

  1. predicts the robot's future for the next HORIZON steps with the unicycle
     model,
  2. chooses the sequence of (speed, turn-rate) commands that keeps that
     predicted path close to the reference, subject to hard limits on speed,
     turn rate and how fast either may change,
  3. applies only the first command, then re-plans from the new state.

Because the limits are part of the optimisation, the controller never asks for
something the robot cannot do - and because it sees the reference ahead of time
it steers back onto the circle without PID's overshoot.

The optimiser is scipy.optimize.minimize (SLSQP): no extra solver packages.
Deterministic, no randomness.  Needs only NumPy, SciPy and Matplotlib.
Writes experiments/03_mpc/{result.json, tracking_error.png}.
"""

import json
import math
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # headless: write files, never open a window
import matplotlib.pyplot as plt
import numpy as np
from scipy.optimize import minimize

# ---- problem constants (inlined on purpose: every tutorial script is self-contained)
DT = 0.05  # s, control period
N_STEPS = 250  # 12.5 s, about one lap
RADIUS = 1.0  # m, reference circle centred on the origin
OMEGA_REF = 0.5  # rad/s, reference turn rate
V_REF = RADIUS * OMEGA_REF  # m/s, reference forward speed
START = (RADIUS + 0.3, -0.2, math.pi / 2 - 0.4)  # the perturbed start from loop 1

# ---- hard limits the plan must respect
V_MIN, V_MAX = 0.0, 0.8  # m/s
OMEGA_MAX = 1.5  # rad/s
ACCEL_MAX = 1.0  # m/s^2, limit on how fast the speed command may change
ALPHA_MAX = 3.0  # rad/s^2, limit on how fast the turn-rate command may change

# ---- MPC tuning
HORIZON = 10  # steps (0.5 s) looked ahead
W_POS = 10.0  # weight on squared position error
W_HEADING = 2.0  # weight on heading error, 1 - cos(error)
W_TERMINAL = 5.0  # extra weight on the last predicted state
W_EFFORT = 0.05  # weight on deviating from the reference controls
W_SMOOTH = 0.5  # weight on command changes between steps

OUT_DIR = Path(__file__).resolve().parent / "03_mpc"


def reference(k):
    """Reference pose (x, y, theta) at step k (the circle simply keeps going past the lap)."""
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


def clip(value, lo, hi):
    return max(lo, min(hi, value))


# ---- the optimisation problem ------------------------------------------------
# Decision vector: u = [v_0, w_0, v_1, w_1, ..., v_{H-1}, w_{H-1}]

BOUNDS = [(V_MIN, V_MAX), (-OMEGA_MAX, OMEGA_MAX)] * HORIZON
DV_MAX = ACCEL_MAX * DT  # largest allowed speed change per step
DW_MAX = ALPHA_MAX * DT  # largest allowed turn-rate change per step


def _rate_rows():
    """Rate limits |u_j - u_{j-1}| <= limit as linear inequalities  A u + b >= 0.

    Returns (A, offsets): `offsets[r]` is the (limit, index of the previous
    command in u or -1 for "the command applied last step") for row pair r.
    """
    rows = []
    for j in range(HORIZON):
        for c, limit in ((0, DV_MAX), (1, DW_MAX)):
            now = 2 * j + c
            before = 2 * (j - 1) + c if j > 0 else -1
            rows.append((now, before, limit, c))
    return rows


RATE_ROWS = _rate_rows()
# constant Jacobian of the constraint vector [limit - diff ..., limit + diff ...]
RATE_JAC = np.array(
    [
        [(-1.0 if i == now else 1.0 if i == before else 0.0) for i in range(2 * HORIZON)]
        for (now, before, _, _) in RATE_ROWS
    ]
    + [
        [(1.0 if i == now else -1.0 if i == before else 0.0) for i in range(2 * HORIZON)]
        for (now, before, _, _) in RATE_ROWS
    ]
)


def make_cost(state, k, last_cmd):
    """Cost of a command sequence from `state` at step `k`."""

    def cost(u):
        u = list(u)
        s = state
        total = 0.0
        prev = last_cmd
        for j in range(HORIZON):
            v, w = u[2 * j], u[2 * j + 1]
            s = step(s, v, w)
            rx, ry, rth = reference(k + j + 1)
            weight = W_TERMINAL if j == HORIZON - 1 else 1.0
            total += weight * (
                W_POS * ((s[0] - rx) ** 2 + (s[1] - ry) ** 2)
                + W_HEADING * (1.0 - math.cos(s[2] - rth))
            )
            total += W_EFFORT * ((v - V_REF) ** 2 + (w - OMEGA_REF) ** 2)
            total += W_SMOOTH * ((v - prev[0]) ** 2 + (w - prev[1]) ** 2)
            prev = (v, w)
        return total

    return cost


def make_rate_constraint(last_cmd):
    def values(u):
        out_lo, out_hi = [], []
        for now, before, limit, c in RATE_ROWS:
            diff = u[now] - (u[before] if before >= 0 else last_cmd[c])
            out_lo.append(limit - diff)
            out_hi.append(limit + diff)
        return np.array(out_lo + out_hi)

    return {"type": "ineq", "fun": values, "jac": lambda u: RATE_JAC}


def solve(state, k, last_cmd, warm):
    result = minimize(
        make_cost(state, k, last_cmd),
        np.array(warm),
        method="SLSQP",
        bounds=BOUNDS,
        constraints=[make_rate_constraint(last_cmd)],
        options={"maxiter": 60, "ftol": 1e-8},
    )
    u = [float(x) for x in result.x]
    if not all(math.isfinite(x) for x in u):
        u = list(warm)
    return u


def run_mpc(start):
    state = start
    last_cmd = (V_REF, OMEGA_REF)  # what the robot was doing before step 0
    plan = [V_REF, OMEGA_REF] * HORIZON
    path, pos_err, radial_err, commands = [], [], [], []
    for k in range(N_STEPS + 1):
        x, y, _ = state
        rx, ry, _ = reference(k)
        path.append((x, y))
        pos_err.append(math.hypot(x - rx, y - ry))
        radial_err.append(math.hypot(x, y) - RADIUS)
        if k == N_STEPS:
            break

        plan = solve(state, k, last_cmd, plan)
        # Apply the first command - projected onto the limits so that a solver
        # that stopped a hair short of feasibility can never break them.
        v = clip(plan[0], max(V_MIN, last_cmd[0] - DV_MAX), min(V_MAX, last_cmd[0] + DV_MAX))
        w = clip(
            plan[1],
            max(-OMEGA_MAX, last_cmd[1] - DW_MAX),
            min(OMEGA_MAX, last_cmd[1] + DW_MAX),
        )
        commands.append((v, w))
        last_cmd = (v, w)
        state = step(state, v, w)
        plan = plan[2:] + plan[-2:]  # shift the plan one step: warm start for the next solve
    return path, pos_err, radial_err, commands


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path, pos_err, radial_err, commands = run_mpc(START)

    speeds = [c[0] for c in commands]
    turns = [c[1] for c in commands]
    prev_v, prev_w = V_REF, OMEGA_REF
    accels, turn_accels = [], []
    for v, w in commands:
        accels.append(abs(v - prev_v) / DT)
        turn_accels.append(abs(w - prev_w) / DT)
        prev_v, prev_w = v, w

    settle = int(2.5 / DT)  # last 2.5 s
    limits = {
        "v_min": V_MIN,
        "v_max": V_MAX,
        "omega_max": OMEGA_MAX,
        "accel_max": ACCEL_MAX,
        "alpha_max": ALPHA_MAX,
    }
    metrics = {
        "initial_error_m": round(pos_err[0], 6),
        "max_error_m": round(max(pos_err), 6),
        "rms_error_m": round(math.sqrt(sum(e * e for e in pos_err) / len(pos_err)), 6),
        "final_error_m": round(sum(pos_err[-settle:]) / settle, 6),
        "overshoot_m": round(max(0.0, -min(radial_err)), 6),
        "max_speed": round(max(speeds), 6),
        "min_speed": round(min(speeds), 6),
        "max_abs_turn_rate": round(max(abs(w) for w in turns), 6),
        "max_accel": round(max(accels), 6),
        "max_turn_accel": round(max(turn_accels), 6),
    }
    result = {
        "loop": "03_mpc",
        "controller": "model predictive control (SLSQP)",
        "dt_s": DT,
        "n_steps": N_STEPS,
        "horizon_steps": HORIZON,
        "limits": limits,
        "metrics": metrics,
        "tracking_error_m": [round(e, 6) for e in pos_err],
        "radial_error_m": [round(e, 6) for e in radial_err],
        "speed_cmd": [round(v, 6) for v in speeds],
        "turn_rate_cmd": [round(w, 6) for w in turns],
    }
    (OUT_DIR / "result.json").write_text(json.dumps(result, indent=2) + "\n")

    t = DT * np.arange(N_STEPS + 1)
    t_cmd = DT * np.arange(N_STEPS)
    ref = np.array([reference(k)[:2] for k in range(N_STEPS + 1)])
    fig, (ax_path, ax_err, ax_cmd) = plt.subplots(1, 3, figsize=(14, 4.2))
    ax_path.plot(ref[:, 0], ref[:, 1], "k--", label="reference")
    ax_path.plot(*zip(*path), label="MPC")
    ax_path.plot(*path[0], "ro", label="start")
    ax_path.set_aspect("equal")
    ax_path.set_xlabel("x [m]")
    ax_path.set_ylabel("y [m]")
    ax_path.set_title("MPC path")
    ax_path.legend(loc="upper right", fontsize=8)
    ax_err.plot(t, pos_err, label="tracking error")
    ax_err.plot(t, radial_err, label="radial error (+ outside / - inside)")
    ax_err.axhline(0.0, color="k", lw=0.5)
    ax_err.set_xlabel("time [s]")
    ax_err.set_ylabel("error [m]")
    ax_err.set_title("MPC tracking error")
    ax_err.legend(fontsize=8)
    ax_cmd.plot(t_cmd, speeds, label="speed v [m/s]")
    ax_cmd.plot(t_cmd, turns, label="turn rate [rad/s]")
    ax_cmd.axhline(V_MAX, color="C0", ls=":", lw=0.8)
    ax_cmd.axhline(OMEGA_MAX, color="C1", ls=":", lw=0.8)
    ax_cmd.set_xlabel("time [s]")
    ax_cmd.set_title("Commands (dotted: limits)")
    ax_cmd.legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(OUT_DIR / "tracking_error.png", dpi=110)
    plt.close(fig)

    print(
        f"03_mpc: final error {metrics['final_error_m']:.4f} m, "
        f"rms {metrics['rms_error_m']:.3f} m, max accel {metrics['max_accel']:.2f} m/s^2"
    )


if __name__ == "__main__":
    main()
