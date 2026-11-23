// test/hermetic_env.ts — which ambient env vars the hermetic per-file setup
// (setup_hermetic_env.ts) clears. Pure, so the contract is unit-testable.
//
// Cleared: every AMICO*/AMICODE*/OPENCODE* operational var a live Amicode shell
// exports (they flip auth mode, fleet routing, app-shelf boot shape, ...).
//
// Preserved: AMICO_TEST_JULIA_PROJECT, the explicit opt-in that names the Julia
// project the slow template suites solve against. It carries no ambient
// operational meaning, and clearing it made those suites skip silently (#2180).
const CLEAR_PREFIXES = ["AMICODE_", "AMICO_", "OPENCODE_"];
const CLEAR_EXACT = new Set(["OPENCODE"]);
const PRESERVE_EXACT = new Set(["AMICO_TEST_JULIA_PROJECT"]);

export function isHermeticallyCleared(key: string): boolean {
  if (PRESERVE_EXACT.has(key)) return false;
  return CLEAR_EXACT.has(key) || CLEAR_PREFIXES.some((p) => key.startsWith(p));
}
