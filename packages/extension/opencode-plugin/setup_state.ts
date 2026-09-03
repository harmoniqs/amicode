// ============================================================================
// Setup-state reader — the plugin-side counterpart of the extension's
// src/setup_state.ts. The extension probes the environment at activation
// (juliaup channel probe, lab.toml schema validation) and writes a snapshot
// to the ops dir; this module reads it at prompt-build time and renders the
// `## Setup state` section ONLY when something needs attention. All ready →
// no section (setup is never raised proactively — the on-block rule lives in
// AGENTS.md's "Tool setup" section).
//
// RUNTIME: same constraints as stack_state.ts — node: builtins only, sibling
// import from the Bun-runtime plugin.
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function setupStateFile(): string {
  const opsDir = process.env.AMICODE_OPS_DIR;
  if (opsDir && opsDir.trim() !== "") return path.join(opsDir.trim(), "setup-state.json");
  return path.join(os.homedir(), ".amico", "amicode", "setup-state.json");
}

interface SetupState {
  at?: string;
  julia?: {
    ready?: boolean;
    juliaupPresent?: boolean;
    channelPresent?: boolean;
    projectInstantiated?: boolean;
    channel?: string | null;
  };
  labToml?: {
    state?: string;
    path?: string;
    firstError?: string;
    errorCount?: number;
  };
}

function readSetupState(): SetupState | undefined {
  try {
    return JSON.parse(fs.readFileSync(setupStateFile(), "utf8")) as SetupState;
  } catch {
    return undefined;
  }
}

/** Age of the snapshot in minutes, when parseable. */
function snapshotAgeMinutes(at: string | undefined): number | undefined {
  if (!at) return undefined;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}

/** The `## Setup state` section, or null when nothing needs attention (the
 *  normal case: everything ready or no snapshot yet — a fresh install before
 *  the extension's first activation wrote one, which the onboarding flow
 *  handles anyway). Rendered problems drive AGENTS.md's "Tool setup" rule:
 *  surface only when the task at hand needs the missing piece. */
export function buildSetupStateSection(): string | null {
  const state = readSetupState();
  if (!state) return null;

  const lines: string[] = [];

  const j = state.julia;
  if (j && j.ready === false) {
    const missing: string[] = [];
    if (j.juliaupPresent === false) missing.push("juliaup not installed");
    if (j.channelPresent === false) missing.push(`channel ${j.channel ?? "?"} not installed`);
    if (j.projectInstantiated === false) missing.push("Piccolo project not instantiated");
    if (missing.length > 0) {
      lines.push(
        `- **Julia toolchain: NOT set up** (${missing.join(" · ")}). Solves cannot run without it. ` +
          "If the current task needs a solve, tell the user and offer **Amicode: Set up Julia** " +
          "(Command Palette — or the `amicode.setupJulia` command): it runs the installer in a " +
          "visible terminal, which is the consent surface — do NOT install Julia yourself and " +
          "do NOT raise this when the task doesn't touch solves.",
      );
    }
  }

  const lab = state.labToml;
  if (lab && lab.state === "invalid") {
    const count = lab.errorCount && lab.errorCount > 1 ? ` (+${lab.errorCount - 1} more)` : "";
    lines.push(
      `- **lab.toml: INVALID** — ${lab.firstError ?? "validation failed"}${count} (\`${lab.path ?? "lab.toml"}\`). ` +
        "The full error list is in the \"Amicode — runs\" output channel. Surface this when " +
        "hardware config is relevant to the task; a malformed profile would silently solve " +
        "against the wrong hardware.",
    );
  }

  if (lines.length === 0) return null;

  const age = snapshotAgeMinutes(state.at);
  const header = age !== undefined ? `## Setup state (snapshot ${age} min old)` : "## Setup state";
  return (
    header +
    "\n\n" +
    lines.join("\n") +
    "\n\n" +
    "Rule: mention these ONLY when the current task actually needs the missing piece — " +
    "never proactively, and never repeat the offer once the user has declined or deferred."
  );
}
