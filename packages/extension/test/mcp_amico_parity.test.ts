// Parity test — the two-transport drift guard (#700 A3).
//
// ONE source of truth: the core's tool table (src/amicode_tools_core.ts),
// keyed by each tool's canonical PRODUCT name (amicode_pick_system, …). Two
// projections must agree on the PRODUCT-IDENTICAL view:
//   - the opencode plugin adapter registers the canonical name verbatim;
//   - the MCP server serves the BARE name (pick_system) — the MCP-native
//     client-namespaces pattern — and opencode's fork renders it back as
//     `<serverName>_<bare>` = `amicode_pick_system` (McpCatalog.toolName,
//     server registered as "amicode").
// So for every core tool: plugin name ≡ "amicode" + "_" + MCP wire name ≡ the
// canonical name, with descriptions and schemas identical throughout. If
// either transport adds, drops, renames, or reshapes a tool, this reds.
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
  const OPENCODE_SERVER_NAME = "amicode"; // the name the injected config registers (opencode_config.ts)

  it("same names, in both projections, from the one core table", () => {
    const mcp = SERVER.listAmicodeMcpTools().map((t: McpTool) => t.name);
    const core = Object.keys(CORE.AMICODE_TOOLS);
    expect(mcp.sort()).toEqual([...core].sort().map((n: string) => CORE.mcpBareName(n)));
  });

  it("the PRODUCT-IDENTICAL view: opencode's rendered MCP name ≡ the plugin's registered name, for all 17", () => {
    const canonical = Object.keys(CORE.AMICODE_TOOLS);
    const rendered = SERVER.listAmicodeMcpTools().map((t: McpTool) => `${OPENCODE_SERVER_NAME}_${t.name}`);
    // bijective: what opencode renders after namespacing the bare names IS the
    // canonical set the plugin registers — the model-visible surface is unchanged.
    expect(rendered.sort()).toEqual([...canonical].sort());
    for (const r of rendered) expect(r, `rendered name ${r} carries the product prefix`).toMatch(/^amicode_/);
  });

  it("same descriptions, verbatim", () => {
    for (const t of SERVER.listAmicodeMcpTools() as McpTool[]) {
      expect(t.description).toBe(CORE.AMICODE_TOOLS[CORE.mcpProductName(t.name)]?.description);
    }
  });

  it("same schemas: inputSchema.properties ≡ the plugin's args, required ≡ every declared key", async () => {
    for (const t of SERVER.listAmicodeMcpTools() as McpTool[]) {
      const def = CORE.AMICODE_TOOLS[CORE.mcpProductName(t.name)];
      expect(t.inputSchema.type).toBe("object");
      expect(JSON.parse(JSON.stringify(t.inputSchema.properties))).toEqual(
        JSON.parse(JSON.stringify(def.args)),
      );
      expect(t.inputSchema.required).toEqual(Object.keys(def.args).sort());
      // and the plugin side agrees — the projection goes through the adapter
      const p = await pluginTool(CORE.mcpProductName(t.name));
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
