# Experiments

Each loop has a script and an artifact directory with the same numbered prefix:
`01_feedforward.py` writes `01_feedforward/`, `02_pid.py` writes `02_pid/`, and
`03_mpc.py` writes `03_mpc/`. The numbers encode the order you run them in.

Each artifact directory holds `result.json` (the deterministic result) and
`tracking_error.png` (the tracking-error plot).
