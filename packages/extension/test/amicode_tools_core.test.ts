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
  "amicode_author_widget",
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

// Issue #799 — the widget-authoring tool (the fork's registry delta ported
// into the harness-neutral floor). The prompt is CARRIED from the fork's
// widget-author.txt (never rewritten), execution drives the extension
// service's widget server helper end-to-end, and the returned LAST line is
// the AMICODE_WIDGET sentinel the UI's preview card parses.
describe("amicode_author_widget (issue #799)", () => {
  const def = () => CORE.AMICODE_TOOLS["amicode_author_widget"] as AmicodeToolDef;

  it("the description is the fork's widget-author.txt, carried byte-for-byte", async () => {
    const { readFileSync } = await import("node:fs");
    const carried = readFileSync(join(__dirname, "..", "src", "widget-author.txt"), "utf8");
    expect(carried.length).toBeGreaterThan(1000);
    expect(def().description).toBe(carried);
  });

  it("the schema is fork-equivalent (id/name/size/height/description/js, tile|hero enum)", () => {
    const args = def().args as Record<string, { type: unknown; enum?: string[]; description: string }>;
    expect(Object.keys(args).sort()).toEqual(["description", "height", "id", "js", "name", "size"]);
    expect(args.size.enum).toEqual(["tile", "hero"]);
    expect(args.id.description).toMatch(/UPDATE that widget in place/);
    expect(args.js.description).toMatch(/export default \{ mount/);
  });

  it("a tool call drives the service helper end-to-end: the widget lands in the dashboard inventory", async () => {
    const { mkdtempSync, existsSync, readFileSync } = await import("node:fs");
    const userDir = mkdtempSync(join(tmpdir(), "amico-widgets-799-"));
    const saved = process.env.AMICODE_WIDGETS_DIR;
    process.env.AMICODE_WIDGETS_DIR = userDir;
    try {
      const out = await def().execute(
        {
          id: "fidelity-leaderboard",
          name: "Fidelity leaderboard",
          size: "hero",
          height: 220,
          description: "Best F per problem",
          js: "export default { mount: function (el, amico) { el.textContent = 'hi' } }",
        },
        { carrier: "mcp" },
      );
      // the tool return carries the UI sentinel as its LAST line
      const lines = out.split("\n");
      expect(lines[lines.length - 1]).toMatch(/^AMICODE_WIDGET /);
      const sentinel = JSON.parse(lines[lines.length - 1].slice("AMICODE_WIDGET ".length));
      expect(sentinel).toMatchObject({ id: "fidelity-leaderboard", name: "Fidelity leaderboard", size: "hero", height: 220 });
      expect(typeof sentinel.hash).toBe("string");
      expect(sentinel.hash.length).toBeGreaterThan(0);
      expect(Array.isArray(sentinel.warnings)).toBe(true);
      expect(out).toMatch(/Pin it to their dashboard/);
      // the helper wrote the widget under the widgets root
      expect(existsSync(join(userDir, "fidelity-leaderboard", "manifest.toml"))).toBe(true);
      expect(existsSync(join(userDir, "fidelity-leaderboard", "widget.js"))).toBe(true);
      expect(readFileSync(join(userDir, "fidelity-leaderboard", "widget.js"), "utf8")).toContain("mount: function");

      // dashboard inventory end-to-end: the extension service's widget route
      // (which reads the same registry) now serves the authored widget. (The
      // dashboard LAYOUT deliberately keeps user widgets opt-in until the
      // user Pins — the tool's contract ends at the registry inventory.)
      const { createAmicodeService } = await import("../src/amicode_service");
      const service = createAmicodeService();
      const base = (await service.start()).toString().replace(/\/$/, "");
      try {
        const headers = { Authorization: service.authHeader };
        const w = await (await fetch(`${base}/amicode/widgets`, { headers })).json();
        const entry = (w.widgets as Array<{ id: string; builtin: boolean; hash: string }>).find(
          (x) => x.id === "fidelity-leaderboard",
        );
        expect(entry, "GET /amicode/widgets serves the authored widget").toBeTruthy();
        expect(entry!.builtin).toBe(false);
        expect(entry!.hash).toBe(sentinel.hash);
      } finally {
        await service.stop();
      }
    } finally {
      if (saved === undefined) delete process.env.AMICODE_WIDGETS_DIR;
      else process.env.AMICODE_WIDGETS_DIR = saved;
    }
  });

  it("re-calling with the SAME id updates in place (new content → new hash)", async () => {
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const userDir = mkdtempSync(join(tmpdir(), "amico-widgets-799b-"));
    const saved = process.env.AMICODE_WIDGETS_DIR;
    process.env.AMICODE_WIDGETS_DIR = userDir;
    try {
      const call = (js: string) =>
        def().execute(
          { id: "my-tile", name: "My tile", size: "tile", height: 120, description: null, js },
          {},
        );
      const first = await call("export default { mount: function (el) { el.textContent = 'v1' } }");
      const second = await call("export default { mount: function (el) { el.textContent = 'v2' } }");
      const h1 = JSON.parse(first.split("\n").pop()!.slice("AMICODE_WIDGET ".length)).hash;
      const h2 = JSON.parse(second.split("\n").pop()!.slice("AMICODE_WIDGET ".length)).hash;
      expect(h1).not.toBe(h2);
      expect(readFileSync(join(userDir, "my-tile", "widget.js"), "utf8")).toContain("'v2'");
    } finally {
      if (saved === undefined) delete process.env.AMICODE_WIDGETS_DIR;
      else process.env.AMICODE_WIDGETS_DIR = saved;
    }
  });

  it("REFUSES a bad widget honestly — nothing is written, the error names the field", async () => {
    const { mkdtempSync, existsSync, readdirSync } = await import("node:fs");
    const userDir = mkdtempSync(join(tmpdir(), "amico-widgets-799c-"));
    const saved = process.env.AMICODE_WIDGETS_DIR;
    process.env.AMICODE_WIDGETS_DIR = userDir;
    try {
      const out = await def().execute(
        { id: "Not_Kebab", name: "X", size: "tile", height: 120, description: null, js: "export default {}" },
        {},
      );
      expect(out).toMatch(/Widget rejected/);
      expect(out).toMatch(/The widget was NOT written/);
      expect(out).toMatch(/bad_id/);
      expect(existsSync(join(userDir, "Not_Kebab"))).toBe(false);
      expect(readdirSync(userDir)).toEqual([]);
      // and a missing mount contract is refused too (the helper's js gate)
      const out2 = await def().execute(
        { id: "ok-id", name: "X", size: "tile", height: 120, description: null, js: "export default {}" },
        {},
      );
      expect(out2).toMatch(/bad_js/);
      expect(existsSync(join(userDir, "ok-id"))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.AMICODE_WIDGETS_DIR;
      else process.env.AMICODE_WIDGETS_DIR = saved;
    }
  });
});

// SEAM 6 (#703) — the tool-surface half of the autonomy datum: the
// amicode_request_approval tool's `bounds` are validated against the SCHEMA
// PACKAGE's warrant-bounds enum (@amicode/schema's $defs.bounds via
// validateBounds), never against a free-text restatement. The datum is one
// knob: a device value outside {none, ro, rw} or a second device-shaped
// field is refused before the card ever renders.
describe("amicode_request_approval — bounds validate against the schema package's datum", () => {
  const def = () => CORE.AMICODE_TOOLS["amicode_request_approval"] as AmicodeToolDef;

  it("renders the ask for valid bounds, for each of the datum's three states", async () => {
    for (const device of ["none", "ro", "rw", undefined]) {
      const bounds = device === undefined ? { max_solves: 2 } : { max_solves: 2, device };
      const out = await def().execute({ plan_hash: "9f2c", bounds }, {});
      expect(out, String(device)).toMatch(/Approval requested/);
    }
  });

  it("REFUSES a device value outside the enum — the datum is not a free string", async () => {
    const out = await def().execute({ plan_hash: "9f2c", bounds: { max_solves: 2, device: "write" } }, {});
    expect(out).toMatch(/Cannot request approval/);
    expect(out).toMatch(/'none'\|'ro'\|'rw'/);
  });

  it("REFUSES a second device-shaped knob riding beside the datum (no second knob)", async () => {
    const out = await def().execute(
      { plan_hash: "9f2c", bounds: { device: "ro", device_access: "rw" } },
      {},
    );
    expect(out).toMatch(/Cannot request approval/);
    // the refusal names the impostor field, not just "bounds"
    expect(out).toMatch(/device_access/);
  });

  it("the bounds arg cites the schema package's formal enum (one definition, not free text)", () => {
    const desc = (CORE.AMICODE_TOOLS["amicode_request_approval"].args as Record<string, { description: string }>)
      .bounds.description;
    expect(desc).toMatch(/@amicode\/schema/);
    expect(desc).toMatch(/none/);
    expect(desc).toMatch(/\bro\b/);
    expect(desc).toMatch(/\brw\b/);
  });
});

describe("the naming contract (canonical product name stored once, #700 director decision)", () => {
  it("mcpBareName strips exactly the amicode_ prefix; mcpProductName restores it", () => {
    expect(CORE.mcpBareName("amicode_pick_system")).toBe("pick_system");
    expect(CORE.mcpBareName("amicode_ask")).toBe("ask");
    expect(CORE.mcpProductName("pick_system")).toBe("amicode_pick_system");
    expect(CORE.mcpProductName(CORE.mcpBareName("amicode_veloce"))).toBe("amicode_veloce");
  });

  it("mcpBareName refuses a non-prefixed canonical name (the table's naming contract)", () => {
    expect(() => CORE.mcpBareName("pick_system")).toThrow(/naming contract/);
    expect(() => CORE.mcpBareName("amicode_")).toThrow(/naming contract/);
  });

  it("every canonical key round-trips bare → product", () => {
    for (const name of Object.keys(CORE.AMICODE_TOOLS)) {
      expect(CORE.mcpProductName(CORE.mcpBareName(name))).toBe(name);
    }
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
