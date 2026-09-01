// ============================================================================
// mcp_amico_server — the MCP stdio TRANSPORT of the amicode_* tool surface
// (#700, harness-contract A3: one implementation, two transports).
//
// The implementations live in ./amicode_tools_core.ts (the tool table); this
// entry projects that table onto the Model Context Protocol over stdio and
// bundles to bin/dist/mcp-amico.mjs (the 4th esbuild target — the extension
// host's injected config points opencode's MCP client at it; any other MCP
// client can spawn the same file).
//
// PROJECTION (what opencode's fork v1.18.10 does with it — packages/opencode/
// src/mcp/catalog.ts): tools/list defs become session tools keyed by
// `McpCatalog.toolName(serverName, def.name)`, so the model-visible name under
// opencode is `<server>_<tool>`. This server serves the tools under their FULL
// core-table names (amicode_pick_system, …) — the parity test pins tools/list ≡
// the plugin's registrations verbatim.
//
// WIRE HYGIENE: stdout is the protocol channel — every diagnostic goes to
// stderr. The startup ritual mirrors the plugin's (stderr load line + the
// one-shot legacy migration, skipped under the same env overrides).
//
// RUNTIME: `node bin/dist/mcp-amico.mjs` (bundled ESM — the core + the SDK ride
// in the bundle; nothing else is imported at runtime). As a module import it is
// side-effect-free (the serve call only fires when invoked as the main script),
// which is what lets the parity test import it.
// ============================================================================

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
import { AMICODE_TOOLS } from "./amicode_tools_core";
import { migrateLegacyEntities, problemsDir } from "../opencode-plugin/problems";

export const AMICODE_MCP_SERVER_NAME = "amicode";
export const AMICODE_MCP_SERVER_VERSION = "0.3.1";

/** A tool as tools/list serves it: the core def projected onto the MCP wire
 *  shape. `required` lists EVERY declared key — the plugin's args-schema
 *  decision (all args required; optional ones nullable) mirrors 1:1. */
export interface AmicodeMcpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

/** The MCP projection of the core table — the parity test's server half. */
export function listAmicodeMcpTools(): AmicodeMcpTool[] {
  return Object.entries(AMICODE_TOOLS).map(([name, def]) => ({
    name,
    description: def.description,
    inputSchema: {
      type: "object",
      properties: def.args,
      required: Object.keys(def.args).sort(),
    },
  }));
}

/** Serve the amicode_* tools over MCP stdio. Resolves (and keeps the process
 *  alive on the transport) once the server is connected; errors go to stderr —
 *  never stdout, which is the protocol channel. */
export async function serveAmicodeMcp(): Promise<void> {
  const server = new Server(
    { name: AMICODE_MCP_SERVER_NAME, version: AMICODE_MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listAmicodeMcpTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const def = AMICODE_TOOLS[name];
    if (!def) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    try {
      const text = await def.execute((request.params.arguments ?? {}) as Record<string, unknown>, {
        carrier: "mcp",
      });
      return { content: [{ type: "text", text }] };
    } catch (err) {
      // Tool-level failure: same honesty contract as the plugin transport —
      // the error text travels to the caller, the process stays up.
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Tool ${name} failed: ${msg}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ── main-script guard ─────────────────────────────────────────────────────────
// `node mcp-amico.mjs` serves; a plain `import` (tests, future embedders) does
// nothing. pathToFileURL keeps the comparison platform-exact (windows drives,
// spaces) — the standard run-as-main idiom for bundled ESM.
const invokedAsMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
  } catch {
    return false;
  }
})();

if (invokedAsMain) {
  console.error(
    `[mcp-amico] loaded — amicode_* tool pack over MCP stdio (${Object.keys(AMICODE_TOOLS).length} tools, problems → ${problemsDir()})`,
  );
  // One-shot legacy migration, the plugin's module-scope ritual mirrored: the
  // same env-skip guard so test harnesses pointing the root at a temp dir are
  // untouched, and a fresh machine migrates identically under either transport.
  if (!process.env.AMICODE_ENTITIES_DIR && !process.env.AMICODE_PROBLEMS_DIR) {
    try {
      migrateLegacyEntities();
    } catch (e) {
      console.error(`[mcp-amico] legacy migration skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  serveAmicodeMcp().catch((err) => {
    console.error(`[mcp-amico] server failed: ${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 1;
  });
}
