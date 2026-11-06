# Amicode Tutorial: Unicycle Control

This is a small, self-contained Research Project. It is the worked example for
the Amicode guided tutorial, and it stays on disk after onboarding so you can
come back to it.

The research question is whether three control strategies (feedforward, PID,
and model-predictive control) can make a unicycle track a circular reference.
The scripts are deterministic, so every run produces the same result.

## Layout

```
amicode-tutorial/
├── research-project.toml   # the project manifest
├── environments/          # the bound research environment (shared knowledge)
├── experiments/
│   ├── 01_feedforward.py  # open-loop tracking, matched and perturbed start
│   ├── 02_pid.py          # closed-loop PID from a perturbed start
│   ├── 03_mpc.py          # MPC with velocity and rate limits
│   ├── 01_feedforward/    # artifacts written by 01_feedforward.py
│   ├── 02_pid/            # artifacts written by 02_pid.py
│   └── 03_mpc/            # artifacts written by 03_mpc.py
└── ledger/                # hypotheses and observations as the loop runs
```

Each experiment writes a `result.json` artifact and a `tracking_error.png` plot
into its own `experiments/<loop>/` directory.

## The three loops

1. **Feedforward.** Open-loop control replays the reference. It tracks exactly
   from the matched initial condition and drifts under a perturbed one.
2. **PID.** Feedback corrects the drift. From a perturbed start it converges to
   the circle, with visible overshoot.
3. **MPC.** A receding-horizon optimizer tracks with the smallest error and
   respects the velocity and rate limits.

## Requirements

Python 3.10 or newer, with NumPy, SciPy, and Matplotlib. Nothing else is
needed: the solver is `scipy.optimize`, not an external package.

## Running a loop

From the project root:

```
python experiments/01_feedforward.py
```

The scripts take no arguments and read no environment variables. Re-running one
overwrites its `experiments/<loop>/` directory with identical output.
