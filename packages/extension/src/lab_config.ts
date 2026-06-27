import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { validateFile, type Validation } from "@amicode/schema";

// ============================================================================
// lab.toml load-time validation (0.1b / S17). A partner lab's lab.toml is the
// only place hardware params enter a solve; validating it on extension load
// turns a malformed/mistyped config into a field-precise error (offending key +
// path) instead of a silent solve against the wrong hardware or an opaque
// mid-solve failure. The schema itself lives in the shared @amicode/schema
// package (0.1a) — this is only the resolve-path + load + surface seam.
// ============================================================================

/** Resolve the lab.toml the extension validates on load. Empty config →
 *  ~/.amico/lab.toml (where install.sh writes the starter). A leading ~ is
 *  expanded, mirroring resolveRunsRoot / resolveJuliaProject. */
export function resolveLabTomlPath(configValue: string): string {
  const v = (configValue ?? "").trim();
  if (v === "") return path.join(os.homedir(), ".amico", "lab.toml");
  if (v === "~") return os.homedir();
  if (v.startsWith("~/")) return path.join(os.homedir(), v.slice(2));
  return v;
}

export type LabCheck =
  | { state: "absent"; path: string }
  | { state: "valid"; path: string }
  | { state: "invalid"; path: string; errors: string[] };

/** Validate the lab.toml at `labPath` against the shared lab schema. A missing
 *  file is `absent` (not an error — a lab may be provisioned later); a present
 *  file is validated field-precise via the single @amicode/schema validator. */
export function checkLabToml(labPath: string): LabCheck {
  if (!fs.existsSync(labPath)) return { state: "absent", path: labPath };
  const v: Validation = validateFile(labPath, "lab");
  return v.ok ? { state: "valid", path: labPath } : { state: "invalid", path: labPath, errors: v.errors };
}
