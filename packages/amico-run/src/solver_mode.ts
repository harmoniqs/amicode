import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ============================================================================
// The selected solver, read from the extension's solver-mode.json contract.
//
// amico-run needs this for exactly one decision: Piccolissimo + Altissimo is a
// CLOUD-ONLY tier, so a LOCAL launch must be refused while it is selected
// (launch.ts). The extension owns writing this file (packages/extension/src/
// solver_mode.ts); we only ever read it, and only the `mode` field.
//
// This is a STATUS read, never a credential read — the file carries no token
// and we never touch cloud.json here (that is remote_config.ts's job, and it
// never returns the token either).
// ============================================================================

export type SolverMode = "piccolo" | "hp";

/** $AMICODE_OPS_DIR → ~/.amico/amicode — the SAME resolution the fork's
 *  amicodeOpsDir(), the extension, and pasqal_verb.ts use, so we read exactly
 *  the file the extension wrote. */
function amicodeOpsDir(env: NodeJS.ProcessEnv): string {
  const v = env.AMICODE_OPS_DIR;
  return v && v.trim() !== "" ? v : join(homedir(), ".amico", "amicode");
}

export function solverModeFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(amicodeOpsDir(env), "solver-mode.json");
}

/** The currently selected solver. Fails SAFE to "piccolo" on an absent,
 *  unreadable, or malformed file: this value can only ever REFUSE a local run,
 *  so guessing "hp" from a corrupt read would block ordinary free-tier work.
 *  A missing file is the normal state for a fresh install. */
export function readSolverMode(env: NodeJS.ProcessEnv = process.env): SolverMode {
  try {
    const parsed = JSON.parse(readFileSync(solverModeFile(env), "utf8")) as { mode?: unknown };
    return parsed.mode === "hp" ? "hp" : "piccolo";
  } catch {
    return "piccolo";
  }
}
