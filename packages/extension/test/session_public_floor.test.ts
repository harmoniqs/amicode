// amicode#826 — the subagent-public floor (ADR-0004 decision 1).
//
// The boundary ruling: the `amicode_session` spawn tool + the subagent
// dispatch infrastructure are PRE-PAY product, never premium. The staging
// audit found the path clean — the tool registers unconditionally in the
// opencode plugin (no entitlement gate on the registration), the spawn
// policy (opencode-plugin/session_spawn.ts) is pure, base worker cards
// stage complete with zero entitlement, and the `issimo` code gates only the
// HP solver tier (src/solver_mode.ts) + premium card overlays
// (src/mode_cards.ts). This file is the ruling's mechanical floor, three
// layers:
//
//   1. the no-entitlement spawn fixture — an EMPTY entitlements config
//      (present file, zero codes), the tool registers and a spawn executes
//      end-to-end through a mock engine client, honest counts +
//      {spawned_by, spawned_depth} metadata stamps (session_spawn_double_
//      create.test.ts's double patterns, extended to record bodies);
//   2. the dispatch-through dimension — with the SAME empty config, the
//      worker base cards stage complete (composing mode_cards_staging.test
//      .ts's base-alone test, which pins the all-cards half) and a spawned
//      child is cast through a staged worker card — the dispatch surface is
//      public end-to-end;
//   3. the entitlement-freedom guards — the blocklist-grep discipline
//      (mode_cards.test.ts): the spawn/dispatch staging sources contain no
//      entitlement/premium reads, so a future entitlement read there goes
//      RED with a failure message naming the ruling.
//
// The audit found the public path COMPLETE — this fixture pins it, it
// changes no behavior. The MCP-floor refusal (spawn refuses on non-opencode
// harnesses) is harness coupling, not entitlement gating: out of scope, and
// the refusal is already honest (amicode_tools_core.ts).
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalEntitlements } from "../src/scores/entitlements";
import {
  PREMIUM_ENTITLEMENT,
  stageModCards,
  cardDispatch,
  validateDispatchTarget,
} from "../src/mode_cards";
import type { AmicodeToolContext } from "../src/amicode_tools_core";

process.env.AMICODE_PROBLEMS_DIR = mkdtempSync(join(tmpdir(), "amicode-826-"));

const CORE = await import("../src/amicode_tools_core");
const PLUGIN = await import("../opencode-plugin/amicode_tools");

const HERE = __dirname;
const EXTENSION_PATH = join(HERE, "..");
const AGENTS_SRC = join(EXTENSION_PATH, "agents");
// The overlay fixture the staging tests share — present on purpose: the
// public floor must hold even with a premium overlay source sitting right
// there, unreached because the entitlement set is empty.
const OVERLAY_ROOT = join(HERE, "fixtures", "overlays", "root");

/** An EMPTY entitlements config: the file is PRESENT (a real config dir,
 * not an absent one) and carries zero codes — the public floor's honest
 * starting state. Same fixture-dir pattern as mode_cards_staging.test.ts's
 * entitlement-resolution test. */
function emptyEntitlementConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "amicode-826-ent-"));
  writeFileSync(join(dir, "entitlements.toml"), "codes = []\n");
  return dir;
}

type EngineVerb = "get" | "create" | "update" | "fork" | "promptAsync";
type EngineCall = { verb: EngineVerb; body: Record<string, unknown> };

/** Mock engine client — session_spawn_double_create.test.ts's double,
 * extended to RECORD every call's body so the metadata stamps and honest
 * counts are asserted directly. Bare payloads (no {data} envelope)
 * exercise unwrap's passthrough branch. */
function makeMockEngine(parent?: { metadata?: unknown }) {
  const calls: EngineCall[] = [];
  let n = 0;
  const engine = {
    session: {
      get: async () => ({ id: "ses_parent", metadata: parent?.metadata, model: undefined }),
      create: async (o: { body?: Record<string, unknown> }) => {
        n += 1;
        calls.push({ verb: "create", body: o?.body ?? {} });
        return { id: `ses_child_${n}` };
      },
      update: async (o: { body?: Record<string, unknown> }) => {
        calls.push({ verb: "update", body: o?.body ?? {} });
        return {};
      },
      fork: async (o: { body?: Record<string, unknown> }) => {
        n += 1;
        calls.push({ verb: "fork", body: o?.body ?? {} });
        return { id: `ses_fork_${n}` };
      },
      promptAsync: async (o: { body?: Record<string, unknown> }) => {
        calls.push({ verb: "promptAsync", body: o?.body ?? {} });
        return {};
      },
    },
  };
  const by = (v: EngineVerb) => calls.filter((c) => c.verb === v);
  return { engine, by };
}

type PluginToolTable = {
  tool: Record<string, { description: string; execute: (a: any, ctx: any) => Promise<string> }>;
};

/** The plugin twin, loaded the way opencode loads it — PluginInput.client is
 * the only thing the spawn path needs, and entitlements are nowhere in it. */
async function pluginPack(engine: unknown): Promise<PluginToolTable> {
  return (await PLUGIN.AmicodeTools({ client: engine })) as PluginToolTable;
}

describe("the no-entitlement spawn fixture (ADR-0004 decision 1, amicode#826)", () => {
  it("the empty entitlements config resolves to zero codes through the real resolution path", () => {
    const cfg = emptyEntitlementConfig();
    const r = readLocalEntitlements(cfg);
    expect(r.entitlements).toEqual([]);
    expect(r.error).toBeUndefined();
    expect(r.entitlements).not.toContain(PREMIUM_ENTITLEMENT);
  });

  it("the plugin registers amicode_session unconditionally — zero entitlement presence", async () => {
    const cfg = emptyEntitlementConfig();
    expect(readLocalEntitlements(cfg).entitlements).toEqual([]); // the floor's state
    const { engine } = makeMockEngine();
    const pack = await pluginPack(engine);
    const def = pack.tool["amicode_session"];
    expect(def, "amicode_session must register with zero entitlement").toBeDefined();
    expect(typeof def?.execute).toBe("function");
    expect(Object.keys(def?.args ?? {})).toEqual([
      "prompt",
      "count",
      "title",
      "agent",
      "model",
      "mode",
      "force",
    ]);
  });

  it("a spawn executes end-to-end under the empty config: one create, one prompt, honest stamps", async () => {
    const { engine, by } = makeMockEngine();
    const pack = await pluginPack(engine);
    const result = await pack.tool["amicode_session"].execute(
      { prompt: "map the frontier", count: 1, mode: "fresh", force: false },
      { sessionID: "ses_parent", directory: "/w" },
    );
    expect(result).toMatch(/Spawned 1 fresh sessions/);
    expect(result).toMatch(/ses_child_1/);
    expect(by("create")).toHaveLength(1);
    expect(by("promptAsync")).toHaveLength(1);
    const created = by("create")[0]!;
    expect(created.body.title).toBe("map the frontier"); // default title, flattened prompt
    expect(created.body.metadata).toEqual({ spawned_by: "ses_parent", spawned_depth: 1 });
    expect(created.body.agent).toBeUndefined(); // no agent → server default, never an entitlement default
    const prompted = by("promptAsync")[0]!;
    expect(
      (prompted.body.parts as Array<{ type: string; text: string }>)[0]?.text,
    ).toBe("map the frontier");
  });

  it("fan-out counts stay honest under the empty config: count=3 creates exactly three children, each stamped", async () => {
    const { engine, by } = makeMockEngine();
    const pack = await pluginPack(engine);
    const result = await pack.tool["amicode_session"].execute(
      { prompt: "sweep the lattice", count: 3, title: "Lattice sweep" },
      { sessionID: "ses_parent", directory: "/w" },
    );
    expect(result).toMatch(/Spawned 3 fresh sessions/);
    expect(by("create")).toHaveLength(3);
    expect(by("promptAsync")).toHaveLength(3);
    const titles = by("create").map((c) => c.body.title);
    expect(titles).toEqual(["Lattice sweep (1/3)", "Lattice sweep (2/3)", "Lattice sweep (3/3)"]);
    for (const c of by("create")) {
      expect(c.body.metadata).toEqual({ spawned_by: "ses_parent", spawned_depth: 1 });
    }
  });

  it("the depth stamps chain through the empty config: a spawned session's own child gets spawned_depth=2", async () => {
    const { engine, by } = makeMockEngine({
      metadata: { spawned_by: "ses_grand", spawned_depth: 1 },
    });
    const pack = await pluginPack(engine);
    const result = await pack.tool["amicode_session"].execute(
      { prompt: "x", count: 1 },
      { sessionID: "ses_parent", directory: "/w" },
    );
    expect(by("create")).toHaveLength(1);
    expect(by("create")[0]!.body.metadata).toEqual({ spawned_by: "ses_parent", spawned_depth: 2 });
    expect(result).toMatch(/Spawned 1/);
  });

  it("the soft depth cap still refuses at depth 2 without force — the cap is policy, never entitlement", async () => {
    const { engine, by } = makeMockEngine({ metadata: { spawned_depth: 2 } });
    const pack = await pluginPack(engine);
    const refused = await pack.tool["amicode_session"].execute(
      { prompt: "x", count: 1, force: false },
      { sessionID: "ses_parent", directory: "/w" },
    );
    expect(refused).toMatch(/Refused: this session is itself a spawned session/);
    expect(refused).toMatch(/force=true/);
    expect(by("create")).toHaveLength(0); // nothing was created — the refusal is a refusal
  });

  it("fork mode stamps the forked child through session.update (the patch path)", async () => {
    const { engine, by } = makeMockEngine();
    const pack = await pluginPack(engine);
    const result = await pack.tool["amicode_session"].execute(
      { prompt: "branch here", count: 1, mode: "fork" },
      { sessionID: "ses_parent", directory: "/w" },
    );
    expect(by("fork")).toHaveLength(1);
    expect(by("update")).toHaveLength(1);
    expect(by("update")[0]!.body.metadata).toEqual({ spawned_by: "ses_parent", spawned_depth: 1 });
    expect(by("promptAsync")).toHaveLength(1);
    expect(result).toMatch(/forked from this session's history/);
  });

  it("the CORE twin (the one implementation both transports project) spawns identically under the empty config", async () => {
    const { engine, by } = makeMockEngine();
    const def = CORE.AMICODE_TOOLS["amicode_session"]!;
    const ctx: AmicodeToolContext = {
      engineClient: engine,
      sessionID: "ses_parent",
      directory: "/w",
      carrier: "plugin",
    };
    const result = await def.execute({ prompt: "map the frontier", count: 1 }, ctx);
    expect(by("create")).toHaveLength(1);
    expect(by("create")[0]!.body.metadata).toEqual({ spawned_by: "ses_parent", spawned_depth: 1 });
    expect(result).toMatch(/Spawned 1 fresh sessions/);
  });
});

describe("dispatch through a staged worker base card (the same empty config, amicode#826)", () => {
  it("the worker cards stage complete with zero entitlement — implementer byte-identical, no overlay fields, no missing-target errors", () => {
    const cfg = emptyEntitlementConfig();
    const destDir = mkdtempSync(join(tmpdir(), "amicode-826-stage-"));
    const r = stageModCards(EXTENSION_PATH, destDir, {
      entitlementConfigDir: cfg, // the real resolution path over the empty fixture dir
      overlaySource: OVERLAY_ROOT, // premium overlay source present, unreached
    });
    // Composes mode_cards_staging.test.ts's base-alone test (which pins the
    // all-cards half with injected entitlements); this pins the DISPATCH half
    // through the real fixture-dir resolution.
    const staged = readFileSync(join(destDir, "implementer.md"), "utf8");
    const base = readFileSync(join(AGENTS_SRC, "implementer.md"), "utf8");
    expect(staged).toBe(base);
    expect(staged).not.toContain("Model routing, tuned:"); // no overlay fields anywhere
    const receipt = JSON.parse(readFileSync(r.receiptPath, "utf8"));
    const rec = receipt.cards.find((c: { card: string }) => c.card === "implementer.md");
    expect(rec.overlay_id).toBeNull();
    expect(rec.merged_fields).toEqual([]);
    expect(r.rejections).toEqual([]); // the dispatch target resolves — no missing-target errors
    // the staged card's dispatch target stays well-formed (the validator staging enforces)
    expect(() => validateDispatchTarget("implementer.md", cardDispatch(staged)!)).not.toThrow();
  });

  it("a spawned child dispatches through the staged worker card with zero entitlement", async () => {
    const cfg = emptyEntitlementConfig();
    const destDir = mkdtempSync(join(tmpdir(), "amicode-826-dispatch-"));
    const staged = stageModCards(EXTENSION_PATH, destDir, {
      entitlementConfigDir: cfg,
      overlaySource: OVERLAY_ROOT,
    });
    expect(staged.staged).toContain("implementer.md"); // the dispatch surface is staged

    // the spawn: a child cast THROUGH that worker card, under the same empty config
    const { engine, by } = makeMockEngine();
    const pack = await pluginPack(engine);
    const result = await pack.tool["amicode_session"].execute(
      { prompt: "implement the slice in the worktree", count: 1, agent: "implementer" },
      { sessionID: "ses_director", directory: "/w" },
    );
    expect(result).toMatch(/Spawned 1 fresh sessions/);
    const created = by("create")[0]!;
    expect(created.body.agent).toBe("implementer"); // the child is cast as the worker card
    expect(created.body.metadata).toEqual({ spawned_by: "ses_director", spawned_depth: 1 });
    const prompted = by("promptAsync")[0]!;
    expect(prompted.body.agent).toBe("implementer"); // the first turn runs under the same card
    expect(
      (prompted.body.parts as Array<{ text: string }>)[0]?.text,
    ).toBe("implement the slice in the worktree");
    // and the card it dispatches through is the staged BASE card — complete,
    // byte-identical to the shipped source, no entitlement anywhere in the path
    expect(readFileSync(join(destDir, "implementer.md"), "utf8")).toBe(
      readFileSync(join(AGENTS_SRC, "implementer.md"), "utf8"),
    );
  });
});

// ── the entitlement-freedom guards (the blocklist-grep discipline) ──────────
//
// Source-level tripwires over the spawn/dispatch staging sources: if a future
// change hangs an entitlement or premium read on the spawn path, these go RED
// with a failure message naming the boundary ruling (ADR-0004 decision 1 /
// amicode#826). The token list is the fixture of record for this guard and
// its non-emptiness is asserted first, so the lens can never go vacuous —
// the same discipline as mode_cards.test.ts's PROPRIETARY_STRINGS.
const ENTITLEMENT_TOKENS = ["entitlement", "premium", "amicissimo"] as const;

// The guarded sources: the spawn policy (whole file — pure by construction,
// no imports) and each transport's amicode_session section (tool registration
// + execute), extracted as the window between the neighboring tool keys so a
// conditional wrapper around the registration lands in the lens too. The core
// table is the ONE implementation (#700 A3); the plugin is the transport the
// ruling's audit named. Entitlement-coupled sources that are SUPPOSED to
// read entitlements (mode_cards.ts's overlay gate, solver_mode.ts's HP tier)
// are deliberately NOT here — the ruling splits subagents from those.
const GUARDED_SOURCES = [
  {
    label: "the spawn policy (opencode-plugin/session_spawn.ts)",
    file: "../opencode-plugin/session_spawn.ts",
  },
  {
    label: "the plugin twin's amicode_session section (opencode-plugin/amicode_tools.ts)",
    file: "../opencode-plugin/amicode_tools.ts",
    window: ["amicode_report_fallback:", "amicode_veloce:"] as const,
  },
  {
    label: "the core tool's amicode_session section (src/amicode_tools_core.ts)",
    file: "../src/amicode_tools_core.ts",
    window: ["amicode_report_fallback:", "amicode_veloce:"] as const,
  },
] as const;

describe("entitlement-freedom guards (ADR-0004 decision 1, amicode#826)", () => {
  it("the guard's token list is non-empty (the lens can never go vacuous)", () => {
    // "entitlement" covers readLocalEntitlements / PREMIUM_ENTITLEMENT /
    // entitlements.toml; "premium" covers PREMIUM_*; "amicissimo" covers the
    // premium code spelled bare.
    expect(ENTITLEMENT_TOKENS.length).toBeGreaterThanOrEqual(3);
  });

  it.each([...GUARDED_SOURCES])(
    "no entitlement/premium read in $label",
    ({ label, file, window }) => {
      let text = readFileSync(join(HERE, file), "utf8");
      if (window) {
        const start = text.indexOf(window[0]);
        const end = text.indexOf(window[1]);
        expect(start, `${label}: tool table restructured — ${window[0]} not found`).toBeGreaterThan(-1);
        expect(end, `${label}: tool table restructured — ${window[1]} not found`).toBeGreaterThan(start);
        text = text.slice(start, end);
        expect(
          text,
          `${label}: the extracted window must contain the amicode_session section — a vacuous window pins nothing`,
        ).toContain("amicode_session");
      }
      for (const tok of ENTITLEMENT_TOKENS) {
        expect(
          text.toLowerCase(),
          `ADR-0004 decision 1 (amicode#826): the subagent surface is pre-pay product, never premium — ` +
            `"${tok}" must not appear in ${label}; an entitlement read on the spawn/dispatch path ` +
            `violates the boundary ruling`,
        ).not.toContain(tok.toLowerCase());
      }
    },
  );
});
