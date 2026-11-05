# Unicycle Tutorial

A small research project you can run in a couple of minutes, laid out exactly like
a real Amicode Research Project. The question: **how much does each control loop
improve a unicycle's tracking of a circle?**

```
research-project.toml        the project manifest (name, question, environment)
environments/unicycle/       the shared setting the experiments run in
experiments/                 one script per loop; each writes a folder of results
ledger/                      where hypotheses, observations and literature notes go
```

## The three loops

| Script | Controller | What you should see |
|---|---|---|
| `experiments/01_feedforward.py` | Replay the reference controls, open loop | Tracks perfectly from the matched start; from the perturbed start the error never goes away |
| `experiments/02_pid.py` | PID on top of the feedforward controls | Converges to the circle from the perturbed start, but overshoots it first |
| `experiments/03_mpc.py` | Model predictive control | Converges without overshoot, and never exceeds the speed, turn-rate or rate-of-change limits |

## Running

Python 3.10 or newer with NumPy, SciPy and Matplotlib. From this directory:

```bash
python experiments/01_feedforward.py
python experiments/02_pid.py
python experiments/03_mpc.py
```

Each script is deterministic (no random numbers) and writes into its own folder,
`experiments/<script name>/`:

- `result.json` - the metrics and time series
- `tracking_error.png` - the plot

The scripts find their output folder from their own location, so you can run them
from any working directory.
