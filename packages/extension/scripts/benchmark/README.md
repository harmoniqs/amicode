# Amicode model-benchmarking harness

Determines which LLMs work best **as the amicode agent** — i.e. driving the 12
`amicode_*` tools through the interview → formulate → solve workflow.

Four **decoupled** stages, wired by files on disk so each re-runs independently:

| Stage | File | Reads | Writes |
|---|---|---|---|
| 1. drive | `driver.ts` | `models.toml`, `scenarios/*.toml` | `out/<model>__<scenario>__runN.jsonl` |
| 2. data | `scenarios/*.toml`, `models.toml` | — | — |
| 3. score | `scorer.ts` + `rubric.ts` | `out/*.jsonl` | `out/scores/*.json`, `out/scores/_all.json` |
| 4. report | `report.ts` | `out/scores/_all.json` | `out/report.md` |

Run each stage with **bun** (it executes the `.ts` directly; the vendored
opencode binary is invoked via `child_process`). Bun is the repo's convention for
`scripts/*.ts` — see `scripts/plugin_exercise.ts`.

## Quick start

```bash
cd packages/extension

# Stage 1 — capture transcripts (all models × all scenarios × 3 runs).
bun scripts/benchmark/driver.ts
# …or a focused subset:
bun scripts/benchmark/driver.ts \
  --models "google/gemini-2.5-flash,amazon-bedrock/anthropic.claude-haiku-4-5-20251001-v1:0" \
  --scenarios S1,S2 --runs 1

# Stage 3 — score (LLM judge on by default; --no-judge for programmatic only).
bun scripts/benchmark/scorer.ts
bun scripts/benchmark/scorer.ts --no-judge

# Stage 4 — ranked report.
bun scripts/benchmark/report.ts
```

### driver.ts flags
- `--models m1,m2` — comma list (default: all `models.toml` candidates).
- `--scenarios S1,S2` — comma list of scenario ids (default: all).
- `--runs N` — runs per cell (default: `models.toml` `runs`).
- `--turn-timeout MS` — per-turn POST timeout (default 240000).
- `--out DIR` — output dir (default `scripts/benchmark/out`).

## How the driver forces a model

The candidate model is set through the **config `model` pin**, NOT the message
body (passing `model` in the message body errors). The driver calls the
extension's real `prepareOpencodeProject` + `buildOpencodeConfigContent` (same
primitives as `test/slow/interview_e2e.test.ts`), passing the candidate as the
`modelPin` argument, and boots **one `opencode serve` per model** (reused across
that model's scenarios × runs; a fresh serve on model change).

## Token / cost / latency availability (probed live 2026-07-17)

**Available.** Per-message `tokens`, `cost`, and `time` live on the opencode
assistant-message `info` block:

- On the **synchronous POST `/session/:id/message` response** →
  `{ info: { cost, tokens:{total,input,output,reasoning,cache:{read,write}},
  time:{created,completed}, modelID, providerID, finish } , parts:[…] }`.
- On **GET `/session/:id/message`** → the full message list, each with the same
  `info` block, plus per-step `cost`/`tokens` on `step-finish` parts.

**Gotcha the driver handles:** one user turn spawns **multiple** assistant
messages (multi-step tool use), and the POST returns only the **last** one. So
after each turn the driver GETs the message list and aggregates `cost`/`tokens`
across every assistant message created for that turn (diffed against the pre-turn
count). Wall-clock is measured around the POST.

**Error gotcha:** opencode errors come back **HTTP 200** with
`info.error = { name, data:{ message, statusCode } }` on an assistant message
(observed for an unavailable model → 403 AccessDeniedException). The driver
inspects `info.error` on every assistant message and records an `error` turn +
terminal `error` record; it never trusts the HTTP status alone.

## Transcript format (`out/*.jsonl`)

One JSON object per line. Union in `types.ts`:
`meta` (cell identity + scenario expectations) → `turn`* (sent, prose, toolCalls
with input args, per-turn usage, wallMs, finish, error) → `done` **or** `error`.
The scorer is a pure function of these lines — scenario expectations are copied
into the transcript so it never re-reads the TOML.

## Scoring axes (`rubric.ts`)

`protocol` (0.35), `completion` (0.35), `robustness` (0.20), `cost` (0.10).
Each cell blends **programmatic checks** (regex `must_match`/`must_not_match`,
`expect_tools`/`forbid_tools`, error detection) with a **fixed LLM judge**.

**Judge model:** the spec's intended judge is `anthropic.claude-opus-4-8`, which
is **not available on this account** — the harness uses
`amazon-bedrock/anthropic.claude-sonnet-4-6` instead (set in `models.toml`).
The judge runs one-shot via `opencode run --pure --model <judge> --format json`
(`--pure` = no amicode plugin/instructions, so the judge is a neutral grader).

The **cost** axis is cohort-relative (normalized over all non-crashed cells), so
it is filled in a second pass after all cells' programmatic + judge scores.

## Scenarios

- **S1** transmon happy-path — one-question cadence, no stage-batching, transmon
  Hamiltonian / `amicode_pick_system`, on to `amicode_formulate`.
- **S2** unknown-platform honesty — "spin qubits": acknowledge as stated, don't
  decline, be honest there's no vetted template.
- **S3** recovery — out-of-order + self-contradictory + nonsense objective;
  graceful continuation, no hallucinated tools.
- **S4** full chain — interview → `amicode_formulate` → `amicode_solve` (long;
  run selectively with `--scenarios S4`).
- **S5** free-form probe — one open-ended turn; captured + judged but
  **excluded** from the head-to-head headline (`exclude_from_headline = true`).
