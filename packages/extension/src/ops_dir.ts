// ops_dir.ts — #1998: the ONE definition of the Amicode ops dir.
//
// `$AMICODE_OPS_DIR` (non-blank) → else `~/.amico/amicode`, where entitlements,
// onboarding, solver-mode, the model-picker config and (now) the model
// reachability cache + routing snapshot live. Leaf module: node builtins only,
// so the service, the opencode plugin and the extension host can all import it.
//
// History: model_reachability.ts and the #864 routingSnapshotFile convention
// once defaulted to `~/.amico` (one level up), so a sibling pair of files
// (picker config / reachability cache) landed in different directories.
// `legacyOpsFile` names that old location so readers can fall back to a file
// written there before the move; WRITERS always write the canonical path.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Ops-side amicode state (queue, lock, onboarding stream, distiller config,
 *  model caches). NOT the vault — operational, per charter/19. */
export function amicodeOpsDir(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.AMICODE_OPS_DIR;
  if (typeof v === "string" && v.trim() !== "") return v;
  return path.join(os.homedir(), ".amico", "amicode");
}

/** Where `name` lived before the ops-dir default was unified: `~/.amico/<name>`.
 *  Only meaningful for the DEFAULT dir — under an `$AMICODE_OPS_DIR` override the
 *  old code wrote to the override too, so there is no legacy location (undefined). */
export function legacyOpsFile(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env.AMICODE_OPS_DIR;
  if (typeof v === "string" && v.trim() !== "") return undefined;
  return path.join(os.homedir(), ".amico", name);
}

/** The file to READ for `canonical`: the canonical path when it exists, else the
 *  legacy path when that exists, else the canonical path (so the caller's own
 *  not-found handling stays unchanged). */
export function readablePath(canonical: string, legacy: string | undefined): string {
  if (legacy === undefined || fs.existsSync(canonical)) return canonical;
  return fs.existsSync(legacy) ? legacy : canonical;
}
