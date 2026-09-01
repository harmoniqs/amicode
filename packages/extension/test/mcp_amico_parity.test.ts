// Parity test — the two-transport drift guard (#700 A3).
//
// ONE source of truth: the core's tool table (src/amicode_tools_core.ts). Two
// projections must agree:
//   - the opencode plugin adapter's registrations (opencode-plugin/amicode_tools.ts),
//   - the MCP server's tools/list (src/mcp_amico_server.ts).
// If either transport adds, drops, renames, or reshapes a tool, this reds.
//
// The env override is set BEFORE the dynamic imports: the plugin adapter still
// carries its module-scope load line + legacy-migration one-shot, and the
// migration guard skips when $AMICODE_PROBLEMS_DIR is set (temp dir → no
// machine-state writes).
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AMICODE_PROBLEMS_DIR = mkdtempSync(join(tmpdir(), "amicode-parity-"));

const CORE = await import("../src/amicode_tools_core");
const PLUGIN = await import("../opencode-plugin/amicode_tools");
const SERVER = await import("../src/mcp_amico_server");

type McpTool = { name: string; description: string; inputSchema: Record<string, unknown> };

const pluginTool = async (name: string) => {
  const pack = (await PLUGIN.AmicodeTools({})) as {
    tool: Record<string, { description: string; args: Record<string, unknown> }>;
  };
  return pack.tool[name];
};

describe("MCP tools/list ≡ the plugin's registrations (drift guard)", () => {
  it("same names, in both projections, from the one core table", () => {
    const mcp = SERVER.listAmicodeMcpTools().map((t: McpTool) => t.name);
    const core = Object.keys(CORE.AMICODE_TOOLS);
    expect(mcp.sort()).toEqual([...core].sort());
  });

  it("same descriptions, verbatim", () => {
    for (const t of SERVER.listAmicodeMcpTools() as McpTool[]) {
      expect(t.description).toBe(CORE.AMICODE_TOOLS[t.name]?.description);
    }
  });

  it("same schemas: inputSchema.properties ≡ the plugin's args, required ≡ every declared key", async () => {
    for (const t of SERVER.listAmicodeMcpTools() as McpTool[]) {
      const def = CORE.AMICODE_TOOLS[t.name];
      expect(t.inputSchema.type).toBe("object");
      expect(JSON.parse(JSON.stringify(t.inputSchema.properties))).toEqual(
        JSON.parse(JSON.stringify(def.args)),
      );
      expect(t.inputSchema.required).toEqual(Object.keys(def.args).sort());
      // and the plugin side agrees — the projection goes through the adapter
      const p = await pluginTool(t.name);
      expect(JSON.parse(JSON.stringify(p.args))).toEqual(JSON.parse(JSON.stringify(def.args)));
      expect(p.description).toBe(t.description);
    }
  });

  it("inputSchema is JSON-Schema-serializable for every tool (the wire contract)", () => {
    for (const t of SERVER.listAmicodeMcpTools() as McpTool[]) {
      const json = JSON.stringify(t.inputSchema);
      expect(() => JSON.parse(json)).not.toThrow();
      expect(json.length).toBeGreaterThan(2);
    }
  });
});
