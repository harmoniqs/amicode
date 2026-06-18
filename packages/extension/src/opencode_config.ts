import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ============================================================================
// Prepare a per-session opencode project directory.
//
// Architecture: opencode invokes amico-run via its built-in `bash` tool — no
// MCP, no callback HTTP. We just need to make sure opencode (a) has context
// about how to use amico-run, and (b) finds it on PATH.
//
// Layout written:
//   <projectDir>/AGENTS.md                  ← LLM context (auto-loaded)
//   <projectDir>/.opencode/opencode.json    ← optional config tweaks
//
// PATH augmentation happens at spawn time (ServerManager env), not here.
// ============================================================================

export interface OpencodeConfigOptions {
  /** Absolute path to amicode-v2/bin/ — added to PATH so `amico-run` resolves. */
  binDir: string;
  /** Absolute path to amicode-v2/AGENTS.md to copy into the project dir. */
  agentsSrc: string;
}

export interface OpencodeProject {
  projectDir: string;
  agentsPath: string;
}

export function prepareOpencodeProject(opts: OpencodeConfigOptions): OpencodeProject {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "amicode-v2-"));
  const opencodeDir = path.join(projectDir, ".opencode");
  fs.mkdirSync(opencodeDir, { recursive: true });

  // Copy AGENTS.md into the project dir. opencode auto-loads it as system
  // context for any session it spawns from this dir.
  const agentsPath = path.join(projectDir, "AGENTS.md");
  if (fs.existsSync(opts.agentsSrc)) {
    fs.copyFileSync(opts.agentsSrc, agentsPath);
  } else {
    // Fallback minimal stub so opencode has *something* to anchor on.
    fs.writeFileSync(
      agentsPath,
      "# Amicode\nInvoke `amico-run --help` via bash to see the solver CLI.\n",
      "utf8",
    );
  }

  // Empty/minimal opencode config — we no longer need MCP or plugin entries.
  // Leaving the file behind so opencode treats this dir as its project root.
  const configPath = path.join(opencodeDir, "opencode.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2),
    "utf8",
  );

  return { projectDir, agentsPath };
}
