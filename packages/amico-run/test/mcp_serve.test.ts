// B5 (issue #112): the `amico mcp-serve` MCP facade. These tests prove the two acceptance
// criteria — (1) mcp-serve LISTS the spine verbs as MCP tools, and (2) a tools/call
// DISPATCHES to the SAME verb function the CLI uses (one impl, two transports) — at three
// levels: the pure verb↔tool mapping, an in-memory Client↔Server round-trip over the real
// MCP protocol, and a real stdio round-trip against the built `amico` bundle.
//
// The SDK imports here live in TEST code, not src/ — the S31 grep guard (s31.test.ts) only
// scans src/, where the MCP SDK is carved out to mcp_serve.ts alone.
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { callMcpTool, createMcpServer, listMcpTools, verbToMcpTool } from "../src/mcp_serve.js";
import { SPINE_VERBS } from "../src/verbs.js";

const BUNDLE = join(__dirname, "..", "dist", "amico.js");
const TOOL_NAMES = ["amico_catalog", "amico_vault", "amico_device", "amico_note"];

// The distinctive JSON a verb.run() returns for given args — the fingerprint we assert the
// tool call reproduces, proving the call reached the SAME verb function.
async function verbJson(verbName: string, argv: string[]): Promise<unknown> {
  const verb = SPINE_VERBS.find((v) => v.name === verbName)!;
  return (await verb.run(argv)).json;
}
function toolText(res: { content: unknown }): string {
  return (res.content as { type: string; text: string }[])[0].text;
}

describe("verb ↔ MCP-tool mapping (pure)", () => {
  it("verbToMcpTool names the tool amico_<verb>, carries the summary + argv schema", () => {
    const v = SPINE_VERBS.find((x) => x.name === "catalog")!;
    expect(verbToMcpTool(v)).toEqual({
      name: "amico_catalog",
      description: v.summary,
      inputSchema: { type: "object", properties: { argv: { type: "array", items: { type: "string" } } } },
    });
  });
  it("listMcpTools exposes exactly the four spine verbs, one tool each", () => {
    const tools = listMcpTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(tools).toHaveLength(SPINE_VERBS.length);
  });
});

describe("callMcpTool dispatches to the same verb function (direct)", () => {
  it("routes amico_note → the note verb; content text is the verb's own JSON", async () => {
    const res = await callMcpTool("amico_note", ["write", "exp-42"]);
    expect(res.isError).toBe(false);
    expect(JSON.parse(toolText(res))).toEqual(await verbJson("note", ["write", "exp-42"]));
  });
  it("unknown tool → structured isError result (not a throw)", async () => {
    const res = await callMcpTool("amico_frobnicate", []);
    expect(res.isError).toBe(true);
    expect(toolText(res)).toMatch(/unknown tool amico_frobnicate/);
  });
});

describe("MCP round-trip over an in-memory transport (real Client + Server)", () => {
  it("tools/list returns the spine verbs; tools/call reaches the same verb function", async () => {
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "amico-mcp-test", version: "0" }, { capabilities: {} });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    // description round-trips from the verb summary
    const catalogTool = tools.find((t) => t.name === "amico_catalog")!;
    expect(catalogTool.description).toBe(SPINE_VERBS.find((v) => v.name === "catalog")!.summary);

    const res = await client.callTool({ name: "amico_device", arguments: { argv: ["status", "--json"] } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(toolText(res as { content: unknown }))).toEqual(
      await verbJson("device", ["status", "--json"]),
    );

    await client.close();
  });
});

describe("MCP round-trip over the REAL stdio transport (built bundle)", () => {
  beforeAll(() => {
    execFileSync("node", [join(__dirname, "..", "esbuild.config.mjs")], { cwd: join(__dirname, "..") });
  });

  it("spawns `amico mcp-serve`, lists tools + dispatches a call over stdio", async () => {
    const transport = new StdioClientTransport({ command: "node", args: [BUNDLE, "mcp-serve"] });
    const client = new Client({ name: "amico-mcp-stdio-test", version: "0" }, { capabilities: {} });
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());

    const res = await client.callTool({ name: "amico_catalog", arguments: { argv: ["lookup", "H-gate"] } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(toolText(res as { content: unknown }))).toEqual(
      await verbJson("catalog", ["lookup", "H-gate"]),
    );

    await client.close(); // terminates the spawned server
  }, 30000);
});
