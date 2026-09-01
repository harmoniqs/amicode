// Round-trip test (#700 A3): spawn the BUILT MCP server (bin/dist/mcp-amico.mjs)
// as a real subprocess, drive initialize → tools/list → tools/call
// (amicode_pick_system) through the official MCP SDK client, and assert the
// entity recording on disk matches what the opencode plugin path produces for
// the same arguments — the same TOML, the same events, the same tool return.
//
// Timestamps (`recorded`, `ts`, `created`) are the only legit divergence — two
// calls happen microseconds apart at most but write distinct ISO stamps — so
// the comparison normalizes them away. Everything else must be byte-equal.
//
// The bundle is built on demand (same esbuild config as the 4th target) so the
// suite is self-sufficient on a fresh clone; `pnpm run build` produces the same
// artifact and the test then exercises exactly that file.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXT = join(__dirname, "..");
const DIST = join(EXT, "bin", "dist", "mcp-amico.mjs");

let mcpRoot: string;
let pluginRoot: string;
let client: Client;

const stripVolatile = (s: string): string =>
  s
    .replace(/^recorded = ".*"$/gm, 'recorded = "<volatile>"')
    .replace(/^created = ".*"$/gm, 'created = "<volatile>"')
    .replace(/"ts":"[^"]*"/g, '"ts":"<volatile>"')
    .replace(/"recorded":"[^"]*"/g, '"recorded":"<volatile>"')
    .replace(/"created":"[^"]*"/g, '"created":"<volatile>"');

const readNormalized = (root: string, rel: string): string =>
  stripVolatile(readFileSync(join(root, rel), "utf8"));

beforeAll(async () => {
  if (!existsSync(DIST)) {
    // Same shape as esbuild.config.mjs's 4th target — one build, no watch.
    const { build } = await import("esbuild");
    await build({
      entryPoints: [join(EXT, "src", "mcp_amico_server.ts")],
      bundle: true,
      platform: "node",
      target: "node20",
      format: "esm",
      outfile: DIST,
      sourcemap: false,
      minify: false,
      logLevel: "silent",
    });
  }
  mcpRoot = mkdtempSync(join(tmpdir(), "amicode-rt-mcp-"));
  pluginRoot = mkdtempSync(join(tmpdir(), "amicode-rt-plg-"));

  client = new Client({ name: "amicode-roundtrip-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      AMICODE_PROBLEMS_DIR: mcpRoot,
    },
  });
  await client.connect(transport);
}, 60_000);

afterAll(async () => {
  await client?.close();
  for (const dir of [mcpRoot, pluginRoot]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("MCP round-trip against the spawned server", () => {
  it("initializes and lists the amicode_* tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("amicode_pick_system");
    expect(names.length).toBeGreaterThanOrEqual(17);
  });

  it("tools/call amicode_pick_system records the SAME entity, events, and return as the plugin path", async () => {
    // ── the plugin path (the reference recording) ──
    process.env.AMICODE_PROBLEMS_DIR = pluginRoot;
    const PLUGIN = await import("../opencode-plugin/amicode_tools");
    const pack = (await PLUGIN.AmicodeTools({})) as {
      tool: Record<string, { execute: (a: unknown, ctx?: unknown) => Promise<string> }>;
    };
    const pluginOut = await pack.tool["amicode_pick_system"].execute(
      { platform: "transmon", omega: 4.8, delta: -0.2 },
      { sessionID: "sess-test", directory: "/tmp/amicode-rt" },
    );

    // ── the MCP path (the same call over the wire) ──
    const result = await client.callTool({
      name: "amicode_pick_system",
      arguments: { platform: "transmon", omega: 4.8, delta: -0.2 },
    });
    expect(result.isError).toBeFalsy();
    const mcpOut = (result.content as Array<{ type: string; text: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");

    // The problem workspace auto-creation is deterministic (same date → same
    // slug), so the tool's LLM-facing return matches verbatim.
    expect(mcpOut).toBe(pluginOut);
    expect(mcpOut).toMatch(/Transmon it is/);
    expect(mcpOut).toContain("AMICODE_DIFF ");

    // ── the on-disk recording: same TOML/JSON sidecar, same event spine ──
    const slug = "untitled-" + new Date().toISOString().slice(0, 10);
    const rel = (p: string) => join(slug, p);
    expect(readNormalized(mcpRoot, rel("entities/system.toml"))).toBe(
      readNormalized(pluginRoot, rel("entities/system.toml")),
    );
    expect(readNormalized(mcpRoot, rel("entities/system.json"))).toBe(
      readNormalized(pluginRoot, rel("entities/system.json")),
    );
    expect(readNormalized(mcpRoot, rel("events.jsonl"))).toBe(
      readNormalized(pluginRoot, rel("events.jsonl")),
    );
    // the score-guard behaves identically: with no score_manifest.json in the
    // temp problems root it is a pass-through — no stage state on EITHER side.
    expect(existsSync(join(mcpRoot, slug, "interview_state.json"))).toBe(false);
    expect(existsSync(join(mcpRoot, slug, "interview_state.json"))).toBe(
      existsSync(join(pluginRoot, slug, "interview_state.json")),
    );
  });

  it("an unknown tool call is an honest MCP error, not a crash", async () => {
    const result = await client.callTool({ name: "amicode_nonexistent", arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text?: string }>)[0]?.text).toMatch(/Unknown tool/);
  });
});
