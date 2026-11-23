// test/slow_gate.ts — the env gate for the slow (real-Julia) suites (#2180).
//
// A slow suite runs only when the env names the Julia project(s) it solves
// against. When it skips, it says why on stderr, so `test:slow` can never
// quietly turn into a no-op again.
type Env = Record<string, string | undefined>;

/** Null when every required var is set (non-empty); otherwise a human reason. */
export function slowSkipReason(env: Env, required: readonly string[]): string | null {
  const missing = required.filter((name) => !env[name]);
  if (missing.length === 0) return null;
  return (
    `${missing.join(", ")} not set. Point it at an instantiated Julia project, e.g. ` +
    `${missing[0]}=$HOME/.amico/julia pnpm --filter amicode run test:slow`
  );
}

/** Evaluate the gate for one suite and log the reason when it skips. Use as
 *  `describe.skipIf(!gate.run)(...)`. */
export function gateSlowSuite(
  suite: string,
  required: readonly string[],
  env: Env = process.env,
): { run: boolean; reason: string | null } {
  const reason = slowSkipReason(env, required);
  if (reason) console.warn(`[${suite}] skipped: ${reason}`);
  return { run: reason === null, reason };
}
