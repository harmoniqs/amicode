// Amicode service roots (M1 port slice 1 — #451).
// Ported from the fork's packages/opencode/src/server/amicode/problems.ts
// (root-resolution functions only; the problems module itself ports in a
// later slice). Same env overrides, same defaults — the parallel-run contract
// tests pin the port to the fork's behavior, so resolution must not diverge.
import { homedir } from "node:os";
import path from "node:path";

export function problemsRoot(): string {
  const env = process.env.AMICODE_PROBLEMS_DIR;
  if (env && env.trim() !== "") return env;
  return path.join(homedir(), ".amico", "problems");
}

export function runsRoot(): string {
  const env = process.env.AMICODE_RUNS_DIR;
  if (env && env.trim() !== "") return env;
  return path.join(homedir(), ".amico", "runs");
}
