import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// Run controls — file-op helpers behind the Run Inspector's Stop / Save pulse
// buttons. Pure enough to unit-test; VSCode wiring lives in extension.ts.
// ============================================================================

/** Request a cooperative stop: the solve template's per-iter callback polls for
 *  this file (in its cwd == the run dir) and returns false to halt Ipopt. */
export function writeStopFile(runDir: string): void {
  fs.writeFileSync(path.join(runDir, "STOP"), "");
}

/** Copy the run's pulse.jld2 to an absolute destination path. */
export function savePulseTo(runDir: string, dest: string): void {
  const src = path.join(runDir, "pulse.jld2");
  if (!fs.existsSync(src)) throw new Error("no pulse.jld2 in the run dir yet");
  fs.copyFileSync(src, dest);
}

/** The team-vault catalog pulses dir if the mount is present, else undefined
 *  (so the Save-pulse quick-pick hides the catalog option when unmounted). */
export function catalogPulsesDir(home = process.env.HOME ?? ""): string | undefined {
  const d = path.join(home, ".amico", "vaults", "armonissima", "catalog", "pulses");
  return fs.existsSync(d) ? d : undefined;
}
