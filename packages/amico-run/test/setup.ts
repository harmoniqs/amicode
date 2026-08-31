// Global test guard: NO TEST MAY EVER SPAWN A REAL MODEL CALL.
//
// `spec review` and `plan compile` resolve their agent binary from $AMICO_CRITIC_BIN, else
// `opencode` on PATH. A developer with opencode installed — which is everyone on this team —
// would otherwise have any test that omits `--offline` and injects no `spawnCritic` fan out
// real, billed frontier critics. The spec registered this as advisory A-11; per-test discipline
// is the wrong fix, because the failure mode is a test someone writes later without thinking
// about it.
//
// So the guard is global and it fails CLOSED: an absolute path that cannot exist makes
// resolveAgentBin() return undefined, which is the documented "no critic binary" degradation.
// A test that WANTS a child sets AMICO_CRITIC_BIN itself (to test/fixtures/fake_agent.mjs) or
// injects a spawnCritic, both of which are explicit.
process.env.AMICO_CRITIC_BIN = "/nonexistent/amico-test-guard/no-real-model-calls";

// Same reasoning for the ledger: tests must never append to the developer's real ops store.
// One shipped test deleted AMICO_BIN to exercise PATH resolution, and since a real `amico` was
// installed that branch RESOLVED IT and performed a real append — ten junk rows accumulated in
// ~/.amico/ledger/runs.jsonl, one per suite run. Individual suites still override this with
// their own temp path; this is the backstop for the ones that forget.
if (!process.env.AMICO_LEDGER) {
  process.env.AMICO_LEDGER = "/nonexistent/amico-test-guard/ledger.jsonl";
}

// And for the coordination claims ledger ($AMICO_CLAIMS_FILE → ~/.amico/ledger/claims.jsonl):
// the coordination-ledger contract suite constructed its service bare, and every run appended
// fixture rows to the real claims ledger — 176 rows before ops archived it 2026-08-30 as
// claims.jsonl.archive-20260830-test-pollution (#642; no in-repo action needed beyond this
// guard). The suite now routes its writes through its own per-run tmp partition; this backstop
// fails closed for the next suite that forgets.
if (!process.env.AMICO_CLAIMS_FILE) {
  process.env.AMICO_CLAIMS_FILE = "/nonexistent/amico-test-guard/claims.jsonl";
}
