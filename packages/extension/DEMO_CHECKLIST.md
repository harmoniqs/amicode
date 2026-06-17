# Amicode demo acceptance checklist (β.6)

Sign off **before** the live demo. The presenter runs this on the target machine
after the [RUNBOOK](./RUNBOOK.md) install. Pre-flight (rows 1–3) is the safety
net; rows 4–6 are the live run.

## Pre-flight (arm the fallback first)

- [ ] **Install clean** — followed `RUNBOOK.md` end-to-end on the target machine; total time recorded below (target ≤ 60 min).
- [ ] **Healthcheck green** — `node packages/extension/scripts/healthcheck.mjs` exits `0` (julia + pinned Piccolo project · opencode `/event` · `amico-run` · Bedrock creds).
- [ ] **Fallback armed** — Command Palette → **"Amicode: Replay demo run"** stages the bundled solve and the Run Inspector renders it (iter frames + final fidelity + promote prompt), with **no Julia, no opencode, no creds**. Confirm this works *before* relying on the live path.

## Live run

- [ ] **Chat → script** — a chat prompt makes the agent read the template, author `solve.jl`, and launch `amico-run` **detached** (`( nohup … & )`); the chat returns immediately with "Solve launched — watch the Run Inspector" and is **not** blocked by the solve.
- [ ] **Inspector streams** — the Run Inspector shows `AMICODE_ITER` rows advancing + `iter_*.png` frames updating while the solve runs in the background.
- [ ] **Fidelity shown** — on completion the inspector reports the final fidelity (F ≥ 0.99 → promote prompt fires automatically).

## Definition-of-Done (Phase β)

- [ ] **Contract frozen** — the run-dir contract + provisional schemas are frozen and documented in [`CONTRACT.md`](./CONTRACT.md).
- [ ] **Timings recorded** — clean-machine install + first-solve timings written into `RUNBOOK.md` (cold first run pays Julia precompile/JIT on top of the warm ~100 s solve).

---

**Recorded timings (fill in at the dry-run):**

| Step | Time |
|---|---|
| Julia install | |
| `install.sh` (instantiate + precompile + VSIX) | |
| Healthcheck | |
| First live solve (cold) | |
| Replay fallback | instant |
| **Total** | |
