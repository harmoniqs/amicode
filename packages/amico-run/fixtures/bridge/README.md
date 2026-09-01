# SEAM 4 bridge fixtures — the canonical replay records

Two committed, synthetic, stable record dirs the Telaio fold must replay —
issued #704, amicode's half of the ledger bridge. The doctrine they carry is
[`docs/ledger-bridge-contract.md`](../../../../docs/ledger-bridge-contract.md);
the validator is
`packages/amico-run/scripts/validate_bridge_replay.mjs` (exit 0 on both by
default; pass a dir to check one; the corruption directions are pinned by
`packages/amico-run/test/bridge_replay.test.ts`).

The replay is against the **SHAPE**, not research history: every value is
synthetic, every hash is real (recomputed over the synthetic content exactly
the way the recorded tools compute it), no real run or experiment is described.

## `amicode-run/` — one canonical amicode run dir

- `run.toml` — v2 manifest (a `--spec` launch): `tier = "vetted"` and
  `[hashes]` whose `system_hash`/`formulation_hash` equal the newest matching
  event hashes, exactly as the launch path stamps them.
- `result.toml` — the solve script's atomic write (`fidelity` + `iterations`).
- `FINISHED` — the harness's terminal marker, written last.
- `events.jsonl` — **the problem-workspace provenance spine, colocated here so
  the replay has one root.** In the real tree it lives at
  `~/.amico/problems/<slug>/events.jsonl` and the run dir joins it via the run
  refs and hashes (see finding 1 in the contract note); nothing about the
  line shape differs. Each event's `hash` is `sha256:` over the canonical JSON
  (key-sorted, `recorded`/`notes` excluded) of the recorded entity **as of that
  event**, so only the LAST event per entity kind matches the final sidecar.
- `entities/{system,formulation,run}.json` — the recorded entity states; the
  validator recomputes the hash chain events ↔ sidecars ↔ `run.toml [hashes]`
  from them.
- `run.log` — the stdout contract: `AMICODE_PULSE_META` once before the solve,
  `AMICODE_PULSE` + `AMICODE_ITER` per iteration (three sampled iterations —
  a real log has one per Ipopt callback; the shape, not the count, is what
  replays), `DONE fidelity=<f>` last, matching `result.toml`.
- Omitted production files (not doctrine-required): `solvespec.json`,
  `pulse.jld2`, `problem.toml`, per-iteration PNG frames.

## `2026-08-31-strumento-task-b3a7/` — one canonical strumento task dir

Named by its id — the TaskRecord contract binds `id == directory basename`.

- `task.toml` — the manifest, `kind = "experiment"` (the reserved axis; the
  record shape is identical for `bringup` ledgers), `config_content_id` a real
  sha256 over a synthetic config string (`cfg-<sha256>` — the calibration
  store's content addressing, carried as a pointer).
- `progress.jsonl` — one line per event kind the contract defines for an
  experiment (`progress`, `heartbeat`, `artifact`, `calibration`, `gate`)
  **plus one unknown `ev` value (`"survey"`) on purpose**: the reader opacity
  rule (unknown-but-well-formed values skip, never fail) is exercised by the
  fixture, not merely asserted by the note.
- `result.toml` — the durable terminal marker (`state = "done"`); its
  existence is the signal.
- `artifacts/fit_002.json` — the file the `artifact` event names; the contract
  requires a recorded artifact path to resolve to a real file inside the task
  dir, so it does.
