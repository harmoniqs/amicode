import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ============================================================================
// Writes a workspace-scoped .opencode/config.json registering:
//   - amico-mcp as a local stdio MCP server (node dist/amico-mcp.js)
//   - the amicode-plugin (relative file URL into dist/amicode-plugin.mjs)
//
// AMICODE_EXTENSION_URL is injected into the MCP server's env so it can
// POST run-state and iter updates back to the extension's CallbackServer.
//
// Strategy: don't pollute the user's workspace with config — we write to
// a per-session temp dir and tell opencode `serve --project=<tempdir>`.
// (opencode treats --project / cwd as the project root; our config lives
// there alongside auto-discovered plugin/ files.)
// ============================================================================

export interface OpencodeConfigOptions {
  /** Absolute path to the dist directory containing amico-mcp.js + amicode-plugin.mjs. */
  distDir: string;
  /** URL of the extension's callback HTTP server (Channel 2). */
  extensionCallbackUrl: string;
  /** Absolute path to spike_solve.jl. */
  juliaScriptPath: string;
  /** Julia project root (--project=...) the MCP will pass to spike_solve.jl. */
  juliaProject: string;
}

export interface OpencodeProject {
  /** Directory we tell opencode to use as its project root. */
  projectDir: string;
  /** Absolute path to the config file we wrote. */
  configPath: string;
}

export function prepareOpencodeProject(opts: OpencodeConfigOptions): OpencodeProject {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "amicode-v2-"));
  const opencodeDir = path.join(projectDir, ".opencode");
  const pluginDir   = path.join(projectDir, "plugin");
  fs.mkdirSync(opencodeDir, { recursive: true });
  fs.mkdirSync(pluginDir,   { recursive: true });

  // Copy/symlink the plugin into the project's plugin/ dir so opencode's
  // auto-discovery picks it up (matches `{plugin,plugins}/*.{ts,js}` glob).
  const pluginSrc = path.join(opts.distDir, "amicode-plugin.mjs");
  const pluginDst = path.join(pluginDir, "amicode-plugin.mjs");
  if (fs.existsSync(pluginSrc)) {
    try { fs.unlinkSync(pluginDst); } catch {}
    fs.symlinkSync(pluginSrc, pluginDst);
  }

  // opencode loads plugins via `config.plugin: string[]`. We point at our
  // bundled ESM file directly — opencode resolves it as a file URL.
  const pluginRef = "file://" + pluginDst;

  const config = {
    $schema: "https://opencode.ai/config.json",
    plugin: [pluginRef],
    mcp: {
      amico: {
        type: "local",
        command: ["node", path.join(opts.distDir, "amico-mcp.js")],
        environment: {
          AMICODE_EXTENSION_URL: opts.extensionCallbackUrl,
          AMICODE_JULIA_SCRIPT:  opts.juliaScriptPath,
          AMICODE_JULIA_PROJECT: opts.juliaProject,
        },
        enabled: true,
      },
    },
  };

  const configPath = path.join(opencodeDir, "opencode.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");

  return { projectDir, configPath };
}
