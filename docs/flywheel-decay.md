# The flywheel decay — the campaign-family derivation (SEAM 7)

The codesign's renewal claim — *each campaign cheaper than the last: the bank makes campaign N+1 warmer than campaign N* — as a number, not a story. This page is the derivation of record (issue #709, spec SEAM 7): the campaign-family key as a **named mechanical derivation per record kind** (never a pre-existing tag, never new stamping), the decay computation's exact formulas, and the F4 findings — the fields the real record kinds lack, stated, never faked.

Delivery path: `amico campaign decay [--runs-root <dir>] [--task-root <dir>] [--store-root <dir>]` (pure core `packages/amico-run/src/flywheel.ts`, verb body `src/campaign_verb.ts`). The studio panel surfacing rides the fork flow (the SEAM 1 UI-half pattern — a named follow-up, out of this slice's scope). **Existing records only: the computation reads, it never stamps.**

## The family taxonomy

The repertoire's eight campaign families (spec-20260831 §"the campaign repertoire"):

| Family | Device-touching? | Derivable from record kinds |
| --- | --- | --- |
| first-pulse | no (sim) | run dirs, store entries |
| regime-sweep | no (sim) | run dirs |
| robustness | no (sim) | run dirs |
| bring-up | yes | task records |
| tune-up | yes | task records, store entries |
| drift-response | yes | store entries |
| team-ops | — | **none** (finding F-709-6) |
| night-runs | — | **none** (finding F-709-6) |

Team-ops and night-runs are session-orchestration facts — no field of any of the three record kinds carries them. The derivation does not attribute them (stated, never forced); they stay unstated until honest stamping exists.

## Derivation (a) — run dir → family

**Fields read (the exact set):** `problem.toml` (falling back to `solvespec.json` — the v4 problem_spec run shape carries one or the other in-dir): `[system].template` (→ platform family via the `platformFromTemplate` rule: strip the `System` suffix, snake_case — `TransmonSystem` → `transmon`), `[goal].kind`, `[goal].gate` | `[goal].target` (→ target), `[problem].free_dt` (the min-time marker), `[problem].objectives[].kind`, top-level `wrappers[].kind`. `run.toml`: `lab_id` (→ workspace), `created_at` (→ campaign day). `result.toml`: `iterations`, `wall_seconds`. `FINISHED`: mtime (wall-clock fallback source only — finding F-709-1).

**Mapping onto the families (stated per family):**

- `[problem].free_dt` present and ≠ false → **regime-sweep** — Piccolo's min-time marker (`free_dt = [lo, hi]` is where the min-time recipe desugars; `false` is the fixed-time default).
- `[problem].objectives[].kind` = `"sensitivity"`, or a top-level `wrappers[]` with kind `"sampling"` → **robustness** — the adjoint-susceptibility / ensemble-sampling hardening family.
- otherwise (goal kind `unitary` or `ket`, one-shot fixed-time synthesis — a gate OR a state) → **first-pulse** — the day-one family. A state-prep run is a one-shot synthesis campaign; it is NOT forced into sweep/robustness.
- bring-up / tune-up / drift-response / team-ops / night-runs are **not derivable from run-dir fields** (they come from task records, store provenance, or nothing).
- A run dir whose `script_path` is an authored `.jl` (the pre-v4 shape — no `problem.toml`/`solvespec.json` in-dir) is **unattributable** — listed with its reason, never forced (finding F-709-5).

## Derivation (b) — task record → family

The strumento TaskRecord shape (`task.toml` + `progress.jsonl` + `result.toml` — the SEAM 4 bridge doctrine's canonical shape).

**Fields read (the exact set):** `task.toml`: `kind` (the manifest's kind axis — required by the bridge contract, values open for forward compat), `device` (→ the device key), `created` (→ campaign day). `result.toml`: `ended`. `progress.jsonl`: events with `ev = "progress"` and `label = "acquire"` (→ acquisitions).

**Mapping onto the families (stated per kind):**

- `kind` matching `/bring-?up/` → **bring-up** — the BringupPlan graph tasks.
- `kind` = `"experiment"` → **tune-up** — the closed-loop family: board experiments and their sim rehearsal (journey §5: pre-P4 this stage delivers SEAM 1's sim rehearsal, and that is all it claims).
- any other kind value is an unknown axis value — the bridge contract's forward-compat rule: derive-and-list, never fail, never force.

## Derivation (c) — store provenance → family (the source stamp)

**Fields read (the exact set):** the pulse bank entry's `metadata.toml` (amico-catalog Phase-0 schema): `id`, `platform`, `date` (→ campaign day), `warm_start`, `calibration_ref` (the source stamp — SEAM 5's chain fingerprint rides the same fields), `device` (→ the device key, when stamped — F-709-2's follow-up, `catalog ingest --device`; empty on pre-#711 entries).

**Mapping onto the families (the most specific stamp present wins):**

- `calibration_ref` set → **drift-response** — the SEAM 5 calibrate→pin→re-optimize→re-bank chain's re-bank, named for the drift that triggered it ("the drift-response tune-up").
- `warm_start` set, no `calibration_ref` → **tune-up** — a warm-started refinement of the incumbent: the closed-loop family's re-solve, exactly where the renewal story ("warmer than campaign N") lives.
- neither → **first-pulse** — the banked terminal artifact of a day-one synthesis campaign.

The banked artifact carries none of the three cost metrics — store-derived campaigns count campaigns and lineage only; their metrics are stated-absent, never faked.

## The campaign and its scope key

**Campaign** (the named mechanical derivation — no record carries a campaign field): the set of same-family, same-scope, same-record-kind records sharing a UTC day. Day ← `run.toml created_at` | `task.toml created` | `metadata.toml date`. The record kind is part of the campaign identity: a run-dir campaign and a task-record campaign of the same family are different series (different metric carriers — mixing them would average stated-absent metrics).

**Scope key** (the spec's scoping):

- sim families (first-pulse, regime-sweep, robustness) → **workspace + platform**: run dirs give `sim:<lab_id>/<platform>`; store entries give `bank:<platform>` (the bank is one workspace).
- device-touching families (bring-up, tune-up, drift-response) → **device**: task records give `device:<task.toml device>`; store entries give `device:<metadata.toml device>` when the entry carries the #711 stamp (`catalog ingest --device`). A store entry with NO device field (pre-#711, finding F-709-2) degrades to the bank scope, stated, and the campaign still computes (a sim-only family with no device field must compute, never vacuously fail).

## The decay metrics (exact formulas)

Per campaign, per metric — the metrics the records carry; **absent ≠ 0**:

- **acquisitions** = Σ over the campaign's task records of the count of `progress.jsonl` events with `ev = "progress"` AND `label = "acquire"`. Run dirs and store entries carry no acquisition counts → stated-absent (F-709-3).
- **iterations** = Σ over the campaign's run dirs of `result.toml` `iterations`. Task records carry solve-iterations only in prose → stated-absent (F-709-4).
- **wall clock (wall_s)** = Σ per-record wall clock:
  - run dir: `result.toml wall_seconds` when present (record-carried; standing on every bundled emitter since #711 — F-709-1's landed follow-up; 2/358 on the real backlog at the finding's census); else `FINISHED` mtime − `run.toml created_at` — the fs fallback, source-labeled per campaign (`wall_source: "record" | "finished-mtime" | "mixed"`), fragile under copy/rsync (finding F-709-1);
  - task record: `result.toml ended` − `task.toml created` (both record-carried);
  - store entry: not carried → stated-absent.

**The trend:** campaigns of a series (family + scope + record kind) ordered by day; campaign N's **delta** vs campaign N−1 per metric present on BOTH sides: absolute (`cur − prev`) and percent (`(cur − prev) / prev × 100`, null when the prior is 0 — no zero-division trend). The **first campaign of a series is the baseline**: `decay: "baseline"`, `deltas: null` — stated, never a zero-division faked number.

## The F4 findings (named, never silently degraded)

- **F-709-1 wall-clock** — the run-dir contract carried no end-time field at the finding's census: `FINISHED` is `status` + `exit_code` only (`writeFinished`, `run_dir.ts`), and `result.toml wall_seconds` was optional (2/358 on the real backlog). Pre-standing records degrade to the `FINISHED` mtime fallback, source-labeled per campaign and fragile under copy/rsync. Landed (amicode #711): `wall_seconds` is a standing field of every bundled contract emitter (the solve's own elapsed time, `wall = time() - t0`), pinned by `packages/extension/test/run_dir_emitters.test.ts` — new campaigns take the record-carried primary path; old records keep the labeled fallback.
- **F-709-2 device key** — `metadata.toml` carried no device field at the finding's census: the device key for device-touching store-derived families (tune-up, drift-response) degraded to the bank scope. Landed (amicode #711): `catalog ingest --device` stamps `device` into the catalog entry metadata, so stamped entries key on their device (`device:<metadata.toml device>`); pre-stamp entries keep the bank-scope degradation, stated.
- **F-709-3 acquisitions** — run dirs carry no acquisition counts (a sim solve acquires nothing on record). The acquisitions metric is stated-absent for run-dir campaigns; it is a task-record metric.
- **F-709-4 iterations** — task records carry solve-iterations only in prose (`result.toml summary`). The iterations metric is stated-absent for task-record campaigns.
- **F-709-5 pre-v4 run dirs** — a run dir whose `script_path` is an authored `.jl` carries no in-dir `(system, goal)` spec (the bridge fixture is exactly this shape). The family is underivable; the record is listed unattributed, never forced.
- **F-709-6 team-ops / night-runs** — no field of any of the three record kinds carries session-orchestration facts. The two families are NOT derivable from existing records; they stay unstated until honest stamping exists (F4's escape: drop the metric or start honest stamping — never a silent fake).

The findings are emitted in every `amico campaign decay` report (`findings`) and pinned by `test/flywheel.test.ts`.

## The proof

- **Unit**: `test/flywheel.test.ts` + `test/campaign_verb.test.ts` over committed canonical fixtures (`fixtures/flywheel/`) and the SEAM 4 bridge fixtures where the shapes match.
- **Real store** (env-gated slow test, the runs store is machine-local): `AMICO_TEST_RUNS_ROOT=<runs-root> pnpm --filter @amicode/amico-run run test:slow` — computes the decay over the real backlog (the director's proof of computability), asserting the first-pulse transmon family aggregates across ≥2 historical campaigns.
