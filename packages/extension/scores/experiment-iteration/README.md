# Experiment-iteration score (harness reframe prototype)

**Status:** prototype for review — `amicode#109` (slice B4), spec `spec-20260708-112732`
§3.2/§4.3. Stands on `amicode#107`'s G-1 ruling (score-first + a thin TS driver
where the stage model can't express iteration).

## What this is

This directory holds a **harness score** — the *data* half of dissolving the
1117-line LLM `orchestrator` for a single experiment iteration. Unlike an
interview `SCORE.md` (questions the user rides), an `ITERATION.toml` declares one
autonomous experiment iteration: which target to solve for, at which trust tier,
and how promotion is gated. The interview repertoire loader only reads
`SCORE.md`, so this file is invisible to that machinery by design.

The **control flow** that walks this data is *code*, not an agent prompt:
[`packages/amico-run/src/harness/experiment_iteration.ts`](../../../amico-run/src/harness/experiment_iteration.ts).

## The iteration, as deterministic code

```
select target (from ITERATION.toml)          ← data, no LLM
      │
dispatch ONE experimenter leaf (flat/depth-1) ← the ONLY model call; it authors the Julia script
      │
derive SolveSpec from the score + launch      ← amico-run --spec runs the launch gate…
      │                                          …and, for tier-2/3, the independent re-rollout
record outcome + gate promotion on `agree`     ← bookkeeping, in code
```

Nothing in that loop is an LLM's judgment except the single flat leaf that
authors the script. The trust-tier, the source exemplar, the env, and the
promote decision are all derived from this score or computed in code.

## Why the driver lives in `amico-run`, not here

Per spec §7.3 the deterministic harness "calls the CLI directly — no LLM," and
`amico-run` is that CLI lineage. The driver shells out to `amico-run --spec`, so
the launch gate and the re-rollout verification are reused verbatim, not
re-implemented. In production the experimenter seam is wired to
`opencode run --agent experimenter` (headless); the driver is UI-agnostic.

## Run the prototype

The prototype runs with **no LLM and no Julia** — the experimenter leaf and the
re-rollout harness are deterministic fakes, so the *control flow* is what's
exercised:

```bash
pnpm --filter @amicode/amico-run build
pnpm --filter @amicode/amico-run demo:harness   # prints each deterministic step + the outcome
pnpm --filter @amicode/amico-run test            # includes the no-LLM iteration test
```

See `packages/amico-run/harness-demo/` for the runnable demo and
`packages/amico-run/test/experiment_iteration.test.ts` for the test.
