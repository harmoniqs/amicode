# The SOTA staging sidecar record — the canonical stream shape (living-sota D3)

One canonical SIDECAR staging record dir (the `sota-staging` record kind the
ledger-bridge validator replays): the per-campaign append-only transition
stream a campaign ledger carries BESIDE itself, plus the hopper fallback
stream. Synthetic values, real shapes — every line is a whole, flushed JSON
object ≤ PIPE_BUF appended with O_APPEND, `seq` is the line count at write
time, and state is derived by replay, never stored.

- `staging.toml` — the record's manifest: the record kind, the campaign the
  sidecar belongs to, and the stamped constants (review-by / expiry /
  compaction windows).
- `session-20260831-bridge-fixture.sota-staging.jsonl` — the campaign sidecar:
  a staged paper (provenance-stamped, review-by/expiry stamps), a staged
  watcher release event (the watcher rides the IDENTICAL shape), the
  PI-instructed accept stamp (instruction provenance recorded), a match that
  expired without review (the recorded drop line), and one still-pending
  stage.
- `hopper.sota-staging.jsonl` — the fallback stream: a below-threshold stage
  line **plus one unknown `ev` on purpose** — the reader-opacity rule,
  exercised by the fixture the same way the strumento fixture carries its
  unknown `ev` probe.

The writer discipline (ONE APPENDER — the digest, the watcher, and the
weekly synthesis are the only stage/drop writers; the accept stamp is the
sole sanctioned non-job append, an agent recording the PI's explicit
instruction) lives in `packages/amico-run/src/sota_staging.ts`; the replay
grammar is enforced by `packages/amico-run/scripts/validate_bridge_replay.mjs`.
