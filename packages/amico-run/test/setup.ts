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

// Same reasoning again, for the cloud: NO TEST MAY EVER SUBMIT A REAL SOLVE.
//
// hpTierSelected() treats the entitlement-resolved allowlist in authoring.json as a signal that
// the Piccolissimo + Altissimo tier is active, and a developer's REAL
// ~/.amico/authoring/authoring.json grants Piccolissimo. So any test that launches without
// --executor promotes to remote, reads the developer's live cloud.json, and submits a billed
// staging job. That is not hypothetical: estimate.test.ts did exactly this and sat 13.5 minutes
// polling the real cloud before failing.
//
// Fails CLOSED the same way as the guards above — a path that cannot exist makes readAuthoring()
// fall back to DEFAULT_ALLOWLIST, which carries no issimo package, so the tier reads as the free
// local one. A test that WANTS the cloud tier writes its own authoring.json and points
// AMICO_AUTHORING_FILE at it (hermeticOpsEnv / authoringGrantingIssimo), which is explicit.
if (!process.env.AMICO_AUTHORING_FILE) {
  process.env.AMICO_AUTHORING_FILE = "/nonexistent/amico-test-guard/authoring.json";
}
// Belt to that brace: even with the tier misread, an absent cloud config makes the promotion
// refuse (exit 64) instead of reaching a real endpoint. Only set when the test has not chosen its
// own — FakeCloud-based tests pass AMICO_CLOUD_URL explicitly.
if (!process.env.AMICO_CLOUD_URL && !process.env.AMICO_CLOUD_TOKEN) {
  process.env.AMICO_CLOUD_FILE = "/nonexistent/amico-test-guard/cloud.json";
}
