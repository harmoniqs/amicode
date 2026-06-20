import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ============================================================================
// Prepare a per-session opencode project directory.
//
// opencode invokes amico-run via its built-in `bash` tool — no MCP, no
// callback HTTP. The amico solve workflow (AGENTS.md) reaches the agent via
// opencode's `instructions` config (see buildOpencodeConfigContent + the
// OPENCODE_CONFIG_CONTENT spawn env in extension.ts), which is loaded for
// every session regardless of the session's working directory. opencode's web
// UI runs the session in the VS Code workspace folder, NOT this temp dir, so
// the temp dir exists only to hold the substituted AGENTS.md — the absolute
// path `instructions` points at. PATH augmentation (so `amico-run` resolves)
// happens at spawn time in extension.ts.
//
// LIFETIME INVARIANT: opencode reads the `instructions` file lazily, per
// message — and a missing file fails *silently* (empty instruction set →
// regression to vanilla opencode). The temp dir is created at activate() and
// is never cleaned by the extension, so it persists for the server's lifetime.
// Do NOT add temp-dir cleanup without moving AGENTS.md somewhere equally durable.
// ============================================================================

/** Resolve the Julia project (--project) the agent should pass. A configured,
 *  non-empty value wins (trimmed); otherwise default to the β.4-provisioned
 *  project at ~/.amico/julia. (The VS Code config default is "", which `??`
 *  does NOT catch — hence an explicit empty check rather than a nullish one.) */
export function resolveJuliaProject(configValue: string): string {
  const v = configValue.trim();
  return v === "" ? path.join(os.homedir(), ".amico", "julia") : v;
}

/** Build the OPENCODE_CONFIG_CONTENT value: a config object that injects the
 *  amico AGENTS.md as a top-level `instructions` entry AND auto-allows the
 *  permissions the solve workflow needs. opencode MERGES this over the user's
 *  global config (model/provider preserved) for every session, independent of
 *  the session's working directory.
 *
 *  Why the `permission` block: the agent reads the bundled template at an
 *  absolute path *outside* the session's working dir and writes scratch to
 *  /tmp/amicode-work, then runs amico-run via bash. opencode defaults
 *  `external_directory` to "ask" — which, with no interactive approver, makes
 *  the turn hang forever (headless) and nags the user on every solve (GUI).
 *  This is a controlled, single-purpose assistant, so we auto-allow the classes
 *  it needs rather than prompt each time. */
export function buildOpencodeConfigContent(agentsPath: string): string {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    instructions: [agentsPath],
    permission: {
      bash: "allow",
      edit: "allow",
      webfetch: "allow",
      external_directory: "allow",
    },
  });
}

export interface OpencodeConfigOptions {
  /** Absolute path to packages/extension/AGENTS.md to substitute + write into the project dir. */
  agentsSrc: string;
  /** Absolute path to the vetted solve_template.jl. Substituted into AGENTS.md
   *  as {{TEMPLATE_PATH}} (the agent reads it there; it is not copied). */
  templateSrc: string;
  /** Julia project (--project) the agent should use; already resolved (see
   *  resolveJuliaProject). Substituted into AGENTS.md as {{JULIA_PROJECT}}. */
  juliaProject: string | undefined;
}

export interface OpencodeProject {
  projectDir: string;
  agentsPath: string;
  /** The vetted template the agent reads — the bundled source (absolute), not a copy. */
  templatePath: string;
}

export function prepareOpencodeProject(opts: OpencodeConfigOptions): OpencodeProject {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "amicode-v2-"));

  // AGENTS.md: read → substitute {{JULIA_PROJECT}} + {{TEMPLATE_PATH}} → write.
  // This file is the target of opencode's `instructions` config (absolute path).
  const agentsPath = path.join(projectDir, "AGENTS.md");
  const raw = fs.existsSync(opts.agentsSrc)
    ? fs.readFileSync(opts.agentsSrc, "utf8")
    : "# Amicode\nRead the template at {{TEMPLATE_PATH}}, fill params, run `amico-run <script>`.\n";
  const filled = raw
    .replaceAll("{{JULIA_PROJECT}}", opts.juliaProject ?? resolveJuliaProject(""))
    .replaceAll("{{TEMPLATE_PATH}}", opts.templateSrc);
  fs.writeFileSync(agentsPath, filled, "utf8");

  // The agent reads the template from its bundled absolute path (the session
  // cwd is the workspace, not this temp dir — so no copy is made here).
  return { projectDir, agentsPath, templatePath: opts.templateSrc };
}
