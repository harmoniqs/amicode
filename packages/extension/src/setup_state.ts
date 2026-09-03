// Setup state (agent-driven tool setup): snapshot of the environment facts the
// in-chat agent needs to surface setup ONLY when it blocks a task — the
// extension-side counterpart of opencode-plugin/setup_state.ts. The extension
// owns the expensive/authoritative probes (juliaup channel probe via process
// spawn, @amicode/schema lab validation) and writes the JSON snapshot to the
// ops dir at activation (and after a healthcheck, which re-probes post-setup);
// the plugin reads it at prompt-build time and renders the section. No toast
// ever fires for any of this — the toast surface was removed.
import * as fs from "node:fs";
import * as path from "node:path";
import { amicodeOpsDir } from "./substrate/vault_store";
import {
  hasJuliaup,
  hasChannel,
  projectInstantiated,
  pinnedJuliaMinor,
  juliaProjectFingerprint,
} from "./substrate/julia_setup";
import { checkLabToml, type LabCheck } from "./lab_config";

export interface SetupState {
  /** ISO timestamp of the snapshot — lets the plugin render freshness honestly. */
  at: string;
  julia: {
    ready: boolean;
    juliaupPresent: boolean;
    channelPresent: boolean;
    projectInstantiated: boolean;
    /** The pinned MINOR channel (e.g. "1.12"), null when unparseable. */
    channel: string | null;
  };
  labToml: {
    state: LabCheck["state"];
    path: string;
    /** First error + count when state === "invalid". */
    firstError?: string;
    errorCount?: number;
  };
}

/** Probe the environment and assemble the snapshot. The julia probes spawn at
 *  most one short-lived process (`julia +<minor> --version`) and only when
 *  juliaup is already present; a bare machine is all file-existence checks. */
export function computeSetupState(o: {
  extensionPath: string;
  juliaProject: string;
  labTomlSetting: string;
}): SetupState {
  // Julia chain (mirrors runJuliaSetup's probe order; juliaup absent → the
  // channel probe is skipped — nothing to probe against).
  const manifestSrc = path.resolve(o.extensionPath, "julia", "Manifest.toml");
  const projectSrc = path.resolve(o.extensionPath, "julia", "Project.toml");
  const channel = pinnedJuliaMinor(manifestSrc);
  const juliaupPresent = channel !== null ? hasJuliaup() : false;
  const channelPresent = channel !== null && juliaupPresent ? hasChannel(channel) : false;
  const fingerprint = channel !== null ? juliaProjectFingerprint(projectSrc, manifestSrc) : null;
  const instantiated = fingerprint !== null ? projectInstantiated(o.juliaProject, fingerprint) : false;

  const lab = checkLabToml(o.labTomlSetting);

  return {
    at: new Date().toISOString(),
    julia: {
      ready: juliaupPresent && channelPresent && instantiated,
      juliaupPresent,
      channelPresent,
      projectInstantiated: instantiated,
      channel,
    },
    labToml:
      lab.state === "invalid"
        ? { state: lab.state, path: lab.path, firstError: lab.errors[0], errorCount: lab.errors.length }
        : { state: lab.state, path: lab.path },
  };
}

/** Write the snapshot to the ops dir (same home as solver-mode.json — the
 *  plugin's default lookup). Best-effort: a failed write just means the agent
 *  sees no Setup-state section this session. */
export function writeSetupStateFile(
  state: SetupState,
  opsDir: string = amicodeOpsDir(),
): void {
  try {
    fs.mkdirSync(opsDir, { recursive: true });
    fs.writeFileSync(path.join(opsDir, "setup-state.json"), JSON.stringify(state, null, 2) + "\n");
  } catch {
    /* non-critical — never block activation on a status file */
  }
}
