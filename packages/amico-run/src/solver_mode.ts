import { readFileSync } from "node:fs";
import { readAuthoring } from "./authoring.js";
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

/** Is the Piccolissimo + Altissimo tier selected, by EITHER of the two signals
 *  that record it?
 *
 *  solver-mode.json alone is not enough. It only changes when something posts a
 *  `status:"switching"` request, so a dropped write leaves it stale — observed
 *  2026-08-05, where it read `piccolo` (dated Jul 28) while the entitlement was
 *  granted and Harmoniqs Cloud was connected. Routing keyed off that file alone,
 *  so a paid-tier solve ran locally on IPOPT and no surface anywhere said so.
 *
 *  The second signal is the entitlement-resolved allowlist in authoring.json,
 *  which session prep writes from the SAME switch and which amico-run already
 *  reads for the gate. Piccolissimo in the allowlist means the issimo entitlement
 *  is granted, and switching back to Piccolo revokes it — so it is self-cleaning
 *  rather than a second thing to keep in sync.
 *
 *  OR, not AND, deliberately: of the two ways to be wrong, silently charging
 *  someone for the cloud tier and giving them a local IPOPT solve is much worse
 *  than telling a revoked user to reconnect. Still fails SAFE overall — with
 *  neither signal present this is false and local runs behave exactly as before. */
export function hpTierSelected(
  env: NodeJS.ProcessEnv = process.env,
  allowlist?: readonly string[],
): boolean {
  if (readSolverMode(env) === "hp") return true;
  return (allowlist ?? readAuthoring().config.allowlist).includes("Piccolissimo");
}
