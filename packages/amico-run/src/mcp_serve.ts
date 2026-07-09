// `amico mcp-serve` — the OPTIONAL MCP facade over the same verbs (spec-20260708-112732
// §7.3). Both runtimes (opencode + Claude Code) have full MCP support, so exposing the
// spine verbs as MCP tools makes them callable-by-name with typed discovery in BOTH,
// without a second implementation.
//
// The mapping is the whole point: each Verb becomes one MCP tool; a tools/call dispatches
// to the SAME Verb.run the CLI uses. One impl, two transports.
//
// B5 SCOPE (issue #112): this lands the REAL @modelcontextprotocol/sdk stdio transport.
// ⚠️ GOVERNANCE — this is the ONLY file in the orchestrator src/ permitted to reference the
// MCP SDK. test/s31.test.ts (S31 / spec §4) bans `modelcontextprotocol` everywhere in src/;
// B5 amends that ban with a single, named carve-out for THIS file only (see the amendment
// block in s31.test.ts), mirroring spec C's single-file SolveSpec carve-out for amico-run.
// The carve-out lifts ONLY the MCP-SDK pattern here — this file stays subject to the HTTP
// and fetch bans (the transport is stdio, never network), and every other src file stays
// under the full ban. Do NOT import the MCP SDK anywhere else.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { SPINE_VERBS, type Verb } from "./verbs.js";

interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown> };
}

/** Verb → MCP tool descriptor. Args pass through as a string[] under `argv`; a real build
 *  would derive a proper JSON-Schema per verb from its flag set. */
export function verbToMcpTool(v: Verb): McpToolDescriptor {
  return {
    name: `amico_${v.name}`,
    description: v.summary,
    inputSchema: { type: "object", properties: { argv: { type: "array", items: { type: "string" } } } },
  };
}

export function listMcpTools(): McpToolDescriptor[] {
  return SPINE_VERBS.map(verbToMcpTool);
}

/** tools/call handler core — dispatches to the SAME Verb.run the CLI uses (one impl, two
 *  transports) and wraps the verb's JSON result as an MCP text block. A non-zero verb exit
 *  code surfaces as isError; an unknown tool name is an isError result (not a throw) so the
 *  MCP client sees a structured tool error rather than a protocol fault. */
export async function callMcpTool(name: string, argv: string[]): Promise<CallToolResult> {
  const verb = SPINE_VERBS.find((v) => `amico_${v.name}` === name);
  if (!verb) {
    return { content: [{ type: "text", text: `amico mcp: unknown tool ${name}` }], isError: true };
  }
  const { json, code } = await verb.run(argv);
  return { content: [{ type: "text", text: JSON.stringify(json) }], isError: code !== 0 };
}

/** Build the MCP server with its two request handlers wired to the shared verb spine:
 *  list-tools → the verb↔tool mapping; call-tool → the same verb function the CLI dispatches.
 *  No transport is attached here, so this is unit-testable over an in-memory transport pair;
 *  serve() attaches the real stdio transport. */
export function createMcpServer(): Server {
  const server = new Server({ name: "amico", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listMcpTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const argv = (req.params.arguments?.argv as string[] | undefined) ?? [];
    return callMcpTool(req.params.name, argv);
  });
  return server;
}

export async function serve(argv: string[]): Promise<number> {
  if (argv.includes("--list")) {
    // Transport-free path: render the verb↔tool mapping (used for discovery + tests).
    console.log(JSON.stringify({ tools: listMcpTools() }, null, 2));
    return 0;
  }
  // Real facade: stand up the MCP stdio server. stdout is the MCP JSON-RPC channel now, so
  // NOTHING may be written to it here (no console.log) — diagnostics go to stderr. The call
  // blocks until the client disconnects, then exits cleanly.
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // Protocol owns transport.onclose; hook the server's onclose so we don't clobber it —
    // fires when the peer closes the session.
    server.onclose = finish;
    // StdioServerTransport watches stdin `data`/`error` only, NOT EOF — so a client that
    // simply disconnects (stdin end) would otherwise hang the process. Close the server on
    // stdin end/close so `amico mcp-serve` always exits cleanly (server.close() → onclose →
    // finish; also drops the stdin listener so the event loop can drain).
    const shutdown = () => void server.close().catch(finish);
    process.stdin.once("end", shutdown);
    process.stdin.once("close", shutdown);
  });
  return 0;
}
