// `amico mcp-serve` — the OPTIONAL MCP facade over the same verbs (spec-20260708-112732
// §7.3). Both runtimes (opencode + Claude Code) have full MCP support, so exposing the
// spine verbs as MCP tools makes them callable-by-name with typed discovery in BOTH,
// without a second implementation.
//
// The mapping is the whole point: each Verb becomes one MCP tool; a tools/call would
// dispatch to the SAME Verb.run the CLI uses. One impl, two transports.
//
// B1 SCOPE (issue #108): this is a STUB seam. `--list` renders the verb↔tool mapping; the
// real transport (an MCP stdio server) is NOT wired here. Note the deliberate constraint:
// test/s31.test.ts (S31 / spec §4) forbids the MCP server SDK inside the orchestrator src,
// so this slice carries ZERO MCP dependency. Landing the real transport body requires an
// explicit, reviewed S31 amendment in a later slice — exactly as spec C amended the S31
// SolveSpec ban to name amico-run the launch gate. Either path here exits cleanly (code 0).

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

/** tools/call handler — dispatches to the same Verb.run the CLI uses. */
export async function callMcpTool(name: string, argv: string[]): Promise<unknown> {
  const verb = SPINE_VERBS.find((v) => `amico_${v.name}` === name);
  if (!verb) throw new Error(`unknown tool ${name}`);
  const result = await verb.run(argv);
  return result.json;
}

export async function serve(argv: string[]): Promise<number> {
  if (argv.includes("--list")) {
    // Demonstrable path: show the verb↔tool mapping without standing up a transport.
    console.log(JSON.stringify({ tools: listMcpTools() }, null, 2));
    return 0;
  }
  // ── the transport seam (the only net-new code MCP adds over the CLI) — lands in a later
  //    slice. It stands up an MCP stdio server whose list-tools returns listMcpTools() and
  //    whose call-tool dispatches to callMcpTool(name, argv). It is intentionally NOT
  //    imported here so this slice stays free of the MCP SDK (S31; see the file header). ──
  console.log(
    JSON.stringify({
      stub: true,
      note: "B1 seam only — the MCP stdio transport is not wired here (S31 keeps the orchestrator SDK-free); use --list for the verb↔tool mapping",
      tools: listMcpTools().map((t) => t.name),
    }),
  );
  return 0;
}
