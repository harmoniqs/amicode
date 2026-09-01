// Tests for the harness-neutral amicode_* tool CORE (#700, A3).
//
// amicode_tools_core.ts holds the ONE implementation of the amicode_* tools:
// filesystem + explicit parameters, no opencode-plugin API. The opencode
// plugin (opencode-plugin/amicode_tools.ts) becomes a thin adapter projecting
// this table, and the MCP stdio server (src/mcp_amico_server.ts) projects the
// SAME table — one source of truth, two transports.
//
// This file pins the table's shape and the adapter's projection (names,
// descriptions, args — the drift guard's plugin half; the MCP half lives in
// mcp_amico_parity.test.ts). The env override is set BEFORE the dynamic
// imports: the plugin adapter still carries its module-scope load line +
// legacy-migration one-shot, and the migration guard skips when
// $AMICODE_PROBLEMS_DIR is set (temp dir → no machine-state writes).
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AMICODE_PROBLEMS_DIR = mkdtempSync(join(tmpdir(), "amicode-core-"));

import type { AmicodeToolDef } from "../src/amicode_tools_core";

const CORE = await import("../src/amicode_tools_core");
const PLUGIN = await import("../opencode-plugin/amicode_tools");

const EXPECTED_TOOLS = [
  "amicode_request_approval",
  "amicode_ask",
  "amicode_problem",
  "amicode_pick_system",
  "amicode_set_model",
  "amicode_formulate",
  "amicode_solve",
  "amicode_verify",
  "amicode_to_hardware",
  "amicode_calibrate",
  "amicode_calib_chain",
  "amicode_profile",
  "amicode_recommend",
  "amicode_report_attempt_error",
  "amicode_report_fallback",
  "amicode_session",
  "amicode_veloce",
];

describe("AMICODE_TOOLS (the core tool table)", () => {
  it("registers exactly the amicode_* tool set, keyed by full name", () => {
    expect(Object.keys(CORE.AMICODE_TOOLS).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it("every entry is a well-formed tool def (description, args, execute)", () => {
    for (const [name, def] of Object.entries(CORE.AMICODE_TOOLS)) {
      expect(typeof def.description, `${name}.description`).toBe("string");
      expect(def.description.length, `${name}.description non-empty`).toBeGreaterThan(20);
      expect(def.args, `${name}.args is an object`).toBeTypeOf("object");
      expect(typeof def.execute, `${name}.execute`).toBe("function");
    }
  });

  it("the harness-coupled tool (amicode_session) degrades honestly without an engine client", async () => {
    const def: AmicodeToolDef = CORE.AMICODE_TOOLS["amicode_session"];
    const out = await def.execute(
      { prompt: "hello", count: 1 },
      { carrier: "mcp" }, // no engineClient — the MCP transport's shape
    );
    expect(out).toMatch(/Cannot spawn/);
    expect(out).not.toMatch(/undefined/);
  });
});

describe("the opencode plugin is a thin adapter over the core", () => {
  it("AmicodeTools projects the core table with identical names, descriptions, and args", async () => {
    const pack = (await PLUGIN.AmicodeTools({})) as {
      tool: Record<string, { description: string; args: unknown; execute: unknown }>;
    };
    const names = Object.keys(pack.tool);
    expect(names.sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const name of names) {
      const def = CORE.AMICODE_TOOLS[name] as AmicodeToolDef;
      expect(pack.tool[name].description, `${name}.description identical`).toBe(def.description);
      // JSON round-trip compare: the projection must not add/drop/reshape a key.
      expect(JSON.parse(JSON.stringify(pack.tool[name].args)), `${name}.args identical`).toEqual(
        JSON.parse(JSON.stringify(def.args)),
      );
      expect(typeof pack.tool[name].execute, `${name}.execute present`).toBe("function");
    }
  });

  it("behavior flows through the adapter unchanged (veloce status, no active problem)", async () => {
    const pack = (await PLUGIN.AmicodeTools({})) as {
      tool: Record<string, { execute: (a: unknown, ctx?: unknown) => Promise<string> }>;
    };
    const viaAdapter = await pack.tool["amicode_veloce"].execute({ action: "status" });
    const viaCore = await CORE.AMICODE_TOOLS["amicode_veloce"].execute({ action: "status" }, {});
    expect(viaAdapter).toBe(viaCore);
    expect(viaAdapter).toMatch(/No active problem yet/);
  });
});
