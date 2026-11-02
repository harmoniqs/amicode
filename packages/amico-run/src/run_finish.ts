// The post-FINISHED half of a local launch, shared by the in-process launcher and adopt mode:
// free-tier re-rollout verification and the exit-code mapping.
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { readFileSync } from "node:fs";
import { readAuthoring } from "./authoring.js";
import { runVerification } from "./verify.js";
import type { Finished, SpecStamp } from "./types.js";

/** Launcher exit code for a settled run: 130 aborted, 0 completed, else julia's rc (1 if rc was 0). */
export function exitCodeFor(f: Finished): number {
  if (f.status === "aborted") return 130;
  if (f.status === "completed") return 0;
  return f.exitCode === 0 ? 1 : f.exitCode;
}

/** Run the free-tier re-rollout verification (always leaves a final verification.toml, never
 *  `pending`) and report whether it agreed. */
export async function verifyFreeLocal(runDir: string, spec: SpecStamp): Promise<boolean> {
  const { config: authoring } = readAuthoring();
  await runVerification(runDir, spec, authoring);
  try {
    const v = parseToml(readFileSync(join(runDir, "verification.toml"), "utf8")) as Record<string, unknown>;
    return v.agree === true;
  } catch {
    return false;
  }
}
