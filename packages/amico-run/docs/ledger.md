# The run ledger

The run ledger is amicode's substrate for **learning loop L-A** (and the
foundation L-B through L-I build on): an append-only JSONL file at
`~/.amico/ledger/runs.jsonl` (override: `$AMICO_LEDGER`) that records every
solve, verdict, validation failure, tier fallback, recommendation override, and
burn — so `amicode_recommend` can retrieve honest, counted priors instead of
guessing, and so the rest of the learning-loops spec
([[spec-20260719-210954-amicode-learning-loops]]) has real signal to work from.

See `packages/schema/schemas/ledger-record.schema.json` for the six record
shapes and `src/ledger_query.ts` for the aggregation math (medians/IQR,
verified-join, the confidence rubric). This document is about **doctrine**:
who may write, what the ledger is (and is not), and why it exists.

## Single-writer discipline

`amico-run` is the **only** process that ever touches `runs.jsonl`. Two
producers, one writer:

- **The Julia runner side**: `LocalExecutor.settle()` (`src/local_executor.ts`)
  derives a `solve` stanza from a completed run's `result.toml` + the
  solvespec (the typed ProblemSpec `run.toml`'s `script_path` resolves to) and
  calls `appendRecord()` directly — it's already inside amico-run.
- **Everyone else** (the opencode extension's `amicode_*` tool pack,
  `amicode_verify`, future replay/dream jobs): shells `amico ledger append`.
  The `ledger` spine verb (`src/ledger_verb.ts`) is the ONE other code path
  that calls `appendRecord()`.

No third path exists, and none should. The extension's `ledger_client.ts`
(`packages/extension/opencode-plugin/ledger_client.ts`) enforces this
structurally, not just by convention — its Bun plugin runtime can only
resolve *relative sibling imports*; `@amicode/amico-run` (where `appendRecord`
lives) is a bare package specifier and is UNREACHABLE from that file. Shelling
`amico ledger append` isn't a style choice there, it's the only door.

Why single-writer matters: `appendRecord`'s O_APPEND atomicity guarantee (no
interleaved lines under concurrent writers) only holds if every writer goes
through the same validated, size-bounded append path
(`packages/amico-run/src/ledger.ts`). A second writer with its own
serialization logic could corrupt the file or bypass schema validation,
producing exactly the "garbage line" failure mode the ledger is designed to
never have.

## Ops-data, not vault knowledge

Per the data/artifacts/entities vocabulary
([[feedback_data_vs_artifacts_vocab]]): the ledger is **data** — raw counts and
joins, nothing curated. It is not a substitute for the vault, and nothing here
should ever be written into a vault mount:

- **Curated insights** (what the counts *mean*, patterns worth remembering)
  still ride the existing **vault → dream → Armonia** path. L-B/L-E/L-G
  (weekly poka-yoke reports, behavior analytics, the dogfood digest) read the
  ledger and *produce* insights, but the ledger itself never becomes a vault
  note.
- **Pulses** stay in the catalog (`repertoire.ts` / `catalog_verb.ts`) — the
  ledger's `solve.warm_start` field is a pointer, never a copy of pulse data.
- The ledger's `structure_hash`-keyed raw records ride an Armonia-style
  ops-data composition (local → team merge, L2) — the SAME plural-composition
  seam Armonia already provides for other ops data, not a bespoke concatenator
  or a second storage system (spec reconciliation #5).

## Only `source:"user"` feeds priors

The `solve` record's `source` field is `"user" | "replay" | "simulated"`.
`ledger_query.ts`'s aggregation filters to `source === "user"` **only** —
both of the other two are excluded from every median/IQR/confidence
computation:

- **`"replay"`** stamps L-I's nightly fleet replay (L3) so scheduled,
  budget-capped regression runs never dilute or skew L-A's per-structure
  counts with synthetic volume. `LocalExecutor.settle()` reads
  `$AMICO_LEDGER_SOURCE` (default `"user"`) so a replay job can override it
  for every run it launches.
- **`"simulated"`** is the Prova persona-QA gym's isolation bridge (a
  deliberate extension of the spec's `user | replay` enum, not a spec
  requirement itself) — Prova points `$AMICO_LEDGER` at a *separate*
  simulated-ledger partition, mirroring its hard-walled `_simulated/` catalog
  partition. Excluding `"simulated"` here too is defense-in-depth: if a
  simulated record ever reached the real `runs.jsonl` by accident, it still
  couldn't contaminate a real prior.

This is the same discipline as
[[feedback_pin_globals_during_initial_pulse_opt]] in spirit: never silently
let a lower-trust signal co-mingle with the one that's supposed to be ground
truth.

## No ML, mechanical only

Every number the ledger produces is a count, a median, an IQR, or a join —
never a model's guess. `queryLedger`'s confidence rubric
(`packages/extension/scores/memory/confidence-rubric.md` §ledger) is a fixed
decision table over $(n, \text{IQR}, \text{verified fraction})$, and "verified"
itself is a plain join (`solve.problem_hash == verdict.problem_hash` AND
`verdict.verdict == "agree"`) — never a similarity score or an embedding
lookup. A recommendation must always be able to say "from $n$ runs, $m$
verified, at this exact structure" and mean it literally.

## Relationship to charter/16 and charter/18

This ledger is **not a new self-improvement system** — it is the concrete
grounding of apparatus amico already has:

- **charter/16's Tier-2 selection signal** has been stuck on one problem: it
  wanted an attribution ledger (mutation → outcome joins) but had no clean
  join key (`active_heuristics` + `skeleton_version` is a poor one).
  `structure_hash` — designed as the cloud routing key, per the main
  typed-spec effort — turns out to *also* be the missing join key. The run
  ledger, keyed on `structure_hash`, **is** Tier-2's attribution ledger; it
  does not sit beside it as a second, competing store.

  One caveat, learned the hard way: `structure_hash` is the right *identity* key
  but not, by itself, the right *retrieval* key. It covers the problem's type
  skeleton, deliberately **not** its goal — a CZ and an X gate on the same
  system, template and solver hash identically, which is exactly what warm-pool
  routing wants (the gate does not change the Julia type) and exactly what priors
  must not do (a hard CZ's median `Q`/`max_iter` are not an easy X gate's). So
  L-A retrieval keys on `structure_hash × goal × (N-bucket, T-bucket)`. The two
  jobs the hash serves want different granularities; the retrieval key is where
  that difference is paid, never by coarsening or refining the hash itself.
- **charter/18 names "Amicode is a single-user IDE tool with no Librarian,
  dream, or catalog feedback; customer usage does not feed the loop" as the
  single most valuable severed coupling in the system.** The ledger — usage
  feeding straight back into `amicode_recommend`'s retrieval — is the first
  reconnection of that product↔engine flywheel. It's the horizontal-axis,
  "the shipped thing IS the engine" move charter/18 says to prioritize over
  building an Architect.

See the learning-loops spec's own "Relationship to charter/16 and /18" section
([[spec-20260719-210954-amicode-learning-loops]]) for the full five-point
reconciliation (counted priors feeding the heuristic registry, L-G as dream
extended to a new surface, L-H as the autonomy gradient per-`structure_hash`,
and the Armonia-transport point above).
