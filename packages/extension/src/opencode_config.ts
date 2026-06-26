import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ============================================================================
// Prepare a per-session opencode project directory.
//
// opencode invokes amico-run via its built-in `bash` tool — no MCP, no
// callback HTTP. We deliver into the session: (a) AGENTS.md (auto-loaded LLM
// context, with the Julia project path substituted in), and (b) the vetted
// solve_template.jl the agent copies + fills in. PATH augmentation (so
// `amico-run` resolves) happens at spawn time in extension.ts.
// ============================================================================

export interface OpencodeConfigOptions {
  /** Absolute path to packages/extension/AGENTS.md to copy into the project dir. */
  agentsSrc: string;
  /** Absolute path to the vetted solve_template.jl to copy into the project dir. */
  templateSrc: string;
  /** Julia project (--project) the agent should use; substituted into AGENTS.md.
   *  undefined → "UNSET" (AGENTS.md tells the agent to omit --project). */
  juliaProject: string | undefined;
}

export interface OpencodeProject {
  projectDir: string;
  agentsPath: string;
  templatePath: string;
}

export function prepareOpencodeProject(opts: OpencodeConfigOptions): OpencodeProject {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "amicode-v2-"));
  fs.mkdirSync(path.join(projectDir, ".opencode"), { recursive: true });

  // AGENTS.md: read → substitute {{JULIA_PROJECT}} → write (auto-loaded by opencode).
  const agentsPath = path.join(projectDir, "AGENTS.md");
  const raw = fs.existsSync(opts.agentsSrc)
    ? fs.readFileSync(opts.agentsSrc, "utf8")
    : "# Amicode\nRead solve_template.jl, fill params, run `amico-run <script>`.\n";
  fs.writeFileSync(agentsPath, raw.replaceAll("{{JULIA_PROJECT}}", opts.juliaProject ?? "UNSET"), "utf8");

  // The vetted template the agent copies and fills in.
  const templatePath = path.join(projectDir, "solve_template.jl");
  if (fs.existsSync(opts.templateSrc)) fs.copyFileSync(opts.templateSrc, templatePath);

  // Minimal opencode config so it treats this dir as a project root.
  fs.writeFileSync(
    path.join(projectDir, ".opencode", "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2),
    "utf8",
  );

  return { projectDir, agentsPath, templatePath };
}
