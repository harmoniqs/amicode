# The ledger bridge contract — one doctrine, three record kinds

> SEAM 4 of the outside-lab codesign (amicode's half; issue #704, part of #679;
> design-of-record: `spec-20260831-120000-amicode-outside-lab-codesign.md`, SEAM 4).
> This note states the shared doctrine ONCE, per record kind. It is the
> coordination artifact — the fold that sits on the research record belongs to
> the other campaign, and its check is named below as theirs.

Three systems independently converged on how a long-running piece of research
records itself so that anything — a reader in another process, on another
machine, in another repo — can reconstruct what happened without asking the
writer:

- **amicode** — the run directory (`run.toml`, `result.toml`, `FINISHED`, the
  problem-workspace `events.jsonl` spine, the `run.log` stdout contract);
- **strumento** — the task directory (`task.toml`, `progress.jsonl`,
  `artifacts/`, `result.toml`), contract of record
  [`strumento/core/record.py`](https://github.com/harmoniqs/strumento) (one file,
  pure stdlib);
- **Telaio** — the harness event spine (append-only per-session JSONL with
  `LEDGER_SCHEMA_VERSION`), the other campaign's surface, named here for
  coordination, not claimed.

## The doctrine (the reasons, not just the shapes)

1. **Append-only event streams.** One JSON object per line, flushed per line.
   State is derived by replay, never stored. `kill -9` loses at most the line in
   flight; a LIVE reader skips an incomplete trailing line and keeps the rest.
   A COMPLETED record with a torn line was never properly terminal — a
   conformance check treats that as corruption (see the validator).
2. **Atomic terminal markers.** Written tmp+fsync+rename, exactly once, at the
   end. Its **existence** is the only durable terminal signal there is; a
   partial marker is not a state a reader can observe, so an unparseable
   terminal marker is corruption, never a race.
3. **Content hashes.** Identities are content-addressed, and every hash travels
   next to what it covers: amicode stamps `sha256:<hex>` over the canonical
   JSON of each recorded entity (in the event and in `run.toml [hashes]`);
   strumento content-addresses calibration versions (`cfg-<sha256>`); Telaio
   content-addresses tool-call arguments (`args_hash`).
4. **Reader opacity (forward compatibility is part of the contract).** Readers
   skip or carry what they do not know — unknown `ev` values, unknown manifest
   kinds, unknown event types — and never fail on it. Well-formed-but-unknown
   skips; malformed is corruption. Writers validate their own input strictly;
   readers tolerate.
5. **Single writer.** No file, and no *field*, has two writers. amicode:
   `amico-run` owns `run.toml` and `FINISHED`; the solve script owns
   `result.toml`/`pulse.jld2`/the stdout contract; the recorded tools own
   `events.jsonl`. strumento: the spawner owns `pid` for supervised runs, the
   script stamps its own `config_content_id`, and no agent-reachable surface
   writes campaign records.

## Per record kind

### (a) amicode's run-dir contract

Written by the `amico-run` launch path (`packages/amico-run/src/run_dir.ts`;
schemas in `packages/schema/schemas/{run,result,finished}.schema.json`):

| element | rule |
|---|---|
| `run.toml` | written **first**, atomically (tmp+rename). v1 bare; v2 (`--spec` launches) adds `tier` + `[hashes]` — `system_hash`/`formulation_hash` stamped from the newest matching events. |
| `result.toml` | written by the **solve script**, atomically. At least `fidelity` (float) + `iterations` (int). |
| `FINISHED` | written **last**, atomically, by the harness. `status` + `exit_code`. Its existence is the durable terminal marker; `FINISHED` without `result.toml` reads as a failed script. |
| `events.jsonl` | the problem workspace's provenance spine: append-only, `seq` monotonic from 1 (seq IS the line count at write time), each event stamped `ts` + a content `hash` over the recorded entity's canonical JSON (`recorded`/`notes` excluded — clock and prose never churn identity). Entity sidecars (`entities/*.json`) are the recorded state; the LAST event per entity kind hashes to exactly them. |
| `run.log` | the stdout contract: `AMICODE_PULSE_META` once (before the solve), `AMICODE_PULSE` + `AMICODE_ITER` per Ipopt iteration, `DONE fidelity=<f>` last. The grammar is pinned in the extension's `run_dir_reader.ts`; the number in `DONE` and in `result.toml` is the same number. |

**The amicode record is a pair, not one directory.** The run dir and the
problem-workspace spine are disjoint in production (`~/.amico/runs/<lab>/` vs
`~/.amico/problems/<slug>/`), joined by the run refs and the hashes. The bridge
fixture colocolates them (below) so a replay has one root, and its README says
so — a fold replaying "a run" joins two roots in the real tree.

### (b) strumento's TaskRecord

Written by `strumento.core.record` (pure stdlib; the format is public — any
QICK user's script can emit it, any language can read it):

| element | rule |
|---|---|
| `task.toml` | the manifest, lowest-common-denominator TOML, no nulls anywhere (absent strings `""`, absent ints `0`). The `id` is **always the directory's basename** — one identity instead of two that can disagree. Carries the reserved `kind` axis (`experiment` \| `bringup`) plus the immutable routing fields; `pid`/`host`/`config_content_id` update in place, each with exactly one writer. |
| `progress.jsonl` | append-only, flushed per line. Event kinds: `progress` (open string→number `metrics` map), `artifact` (task-dir-relative path that must resolve to a real file, `..` rejected at every boundary), `heartbeat`, `calibration` (`cfg-<sha256>` — the calibration-store pointer moved), `gate` (a verdict computed by vetted code — the task script routes it, never authors it), plus the campaign events for `kind="bringup"` ledgers (`claim`, `step_open`, `step_close`, `park`, `approve`, `resume`). Unknown `ev` values **skip, never fail**. |
| `result.toml` | the durable terminal marker, written exactly once, atomically. Its existence ⇒ terminal; `state` ∈ `done|failed|cancelled`; `error_kind` splits failures by *who fixes them*. |
| derived state | a pure, total function of (record, pid-liveness), recomputed at read time, stored nowhere. |

### (c) Telaio's event spine — the OTHER campaign's surface

Named here because the fold that will sit ON the research record is Telaio's
deliverable, sequenced behind **their T4 serve milestones** — the Organs fold
replays both fixtures below, and **`t4_fold_replays_fixtures` is their
criterion**, owned and verified in their campaign, tracked from their ledger
into this note. Their spine elements, stated for coordination: sessions are
append-only JSONL with `LEDGER_SCHEMA_VERSION` stamped on every event and
`seq` monotonic within the session; the **closed event union** (additive
extension per release); the **unknown-event carrying rule** — a reader carries
event types it does not know through the replay, folding only what it
understands, never failing the read. Amicode's half does not depend on the
fold: **the F3 non-arrival reduction** — if T4 slips indefinitely, this seam
completes as this note + the fixtures, and amicode's reports stay readable
through its own surfaces (the Run Inspector, the problem-workspace spine, the
`amico-run` launch/verify path) exactly as they do today.

## The replay fixtures + validator (amicode's half, shipped here)

- `packages/amico-run/fixtures/bridge/amicode-run/` — one canonical amicode run
  dir: `run.toml` (v2), atomic `result.toml` + `FINISHED`, the colocated
  `events.jsonl` with **real content hashes** over `entities/*.json`, and
  `run.log` carrying the stdout contract.
- `packages/amico-run/fixtures/bridge/2026-08-31-strumento-task-b3a7/` — one
  canonical strumento task dir (named by its id, per the contract):
  `task.toml` (`kind = "experiment"`), `progress.jsonl` with the known event
  kinds **plus one unknown `ev` on purpose** (the opacity rule, exercised, not
  asserted), `result.toml`, and the artifact the `artifact` event names.
- `packages/amico-run/scripts/validate_bridge_replay.mjs` — the replay
  validator: exit 0 on both fixtures, non-zero on doctrine violations (a torn
  terminal marker, a mutated content hash, a missing terminal marker, a torn
  append-only stream, a non-contiguous `seq`, an escaping/void artifact path, a
  broken stdout-contract line). No Julia, no Python — the fixtures are
  committed data. `node packages/amico-run/scripts/validate_bridge_replay.mjs`
  with no arguments validates both; pass a record dir to validate one.

Both fixtures are **minimal canonical records** — synthetic values, real
shapes; the fold's replay is against the SHAPE, not our research history.

## Cross-seam reference: the one autonomy doctrine (SEAM 6)

The device profile datum — **`none | ro | rw`** — is the single switch every
system reads: amicode's warrant bounds carry it (the warrant is what gates a
solve's autonomy), strumento's P4 gate reads it end-to-end **merge-gated on
strumento #75**, and Telaio's warrant bounds deserialize from the same shared
datum (their conformance check is named in this seam's campaign ledger). One
autonomy doctrine, three readers, no second knob. The amicode half of SEAM 6
is a parallel slice; the datum contract lives there, this note only points at
it.

## Named findings — doctrine shortfalls in the real record kinds

Named, not papered over (each is a finding to be filed against its owning
surface; no record-format change rides this seam — the contract describes what
IS):

1. **The amicode record spans two directories** (run dir + problem-workspace
   spine). The doctrine's "the directory is the truth" holds only per half; a
   fold must join two roots to replay one run's full provenance. The fixture
   documents the colocated form; no format change is proposed.
2. **strumento's `progress.jsonl` lines carry no per-line content hash** — the
   record's content-addressing lives in the calibration store
   (`cfg-<sha256>`) and the manifest pointer; the event stream itself is not
   tamper-evident. A tampered `progress.jsonl` line is indistinguishable from
   an honest one at the record boundary.
3. **amicode's stdout contract (`run.log`) is likewise un-hashed** — the
   `AMICODE_ITER`/`AMICODE_PULSE`/`DONE` lines carry telemetry, not provenance;
   amicode's hashes cover entities and the solvespec, never the stdout tee.
   Both are honest telemetry; neither claims integrity it cannot check.
