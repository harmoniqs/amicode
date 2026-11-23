// An executable stand-in for the agent CLI, for tests that drive `spec review` / `plan compile`
// through the REAL resolution path ($AMICO_CRITIC_BIN → runAgent → spawn), not an injected
// spawnCritic/runPlanner.
//
// The fixture's FAKE_AGENT_* controls are baked into a wrapper script rather than set in the env:
// buildChildEnv's allowlist correctly refuses to forward them, and routing them through it would
// weaken the guarantee the canary test in agent_spawn.test.ts proves.
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FAKE = join(__dirname, "fake_agent.mjs");

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Write `<dir>/fake-agent` and return its absolute path, for $AMICO_CRITIC_BIN. */
export function fakeAgentBin(dir: string, fakeEnv: Record<string, string>): string {
  const bin = join(dir, "fake-agent");
  const exports = Object.entries(fakeEnv)
    .map(([k, v]) => `export ${k}=${shQuote(v)}`)
    .join("\n");
  writeFileSync(bin, `#!/bin/sh\n${exports}\nexec ${shQuote(process.execPath)} ${shQuote(FAKE)} "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}
