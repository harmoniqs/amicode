// amicode#860 — the dispatch seam: amicode_session consults the routing
// resolver when it spawns THROUGH a role card (agent set), and passes the
// resolved model to the spawned pass. The invariant under test is the
// zero-config byte-identity: with no routing configuration, the engine
// calls (create/promptAsync bodies) and the summary are byte-identical to
// today's un-routed dispatch.
//
// Composes session_public_floor.test.ts's mock-engine fixture (the same
// call-recording double) and model_routing.test.ts's ops-dir fixtures.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  routingPrefsFile,
  routingSnapshotFile,
  writeUserSetRole,
  setSuggestedOptIn,
  writeProviderSnapshot,
} from "../opencode-plugin/model_routing";

process.env.AMICODE_PROBLEMS_DIR = mkdtempSync(join(tmpdir(), "amicode-860-dispatch-"));

const CORE = await import("../src/amicode_tools_core");
const PLUGIN = await import("../opencode-plugin/amicode_tools");

const AGENTS_SRC = join(__dirname, "..", "agents");

type EngineVerb = "get" | "create" | "update" | "fork" | "promptAsync";
type EngineCall = { verb: EngineVerb; body: Record<string, unknown> };

function makeMockEngine(parent?: { metadata?: unknown; model?: { providerID: string; modelID: string } }) {
  const calls: EngineCall[] = [];
  let n = 0;
  const engine = {
    session: {
      get: async () => ({ id: "ses_parent", metadata: parent?.metadata, model: parent?.model }),
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

async function pluginPack(engine: unknown): Promise<PluginToolTable> {
  return (await PLUGIN.AmicodeTools({ client: engine })) as PluginToolTable;
}

describe("the dispatch seam (amicode#860)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "amc-860-seam-"));
    // the tool execute path reads the ops dir from process.env (the engine
    // process's env; the default falls back to ~/.amico/amicode)
    process.env.AMICODE_OPS_DIR = dir;
  });
  const env = () => ({ AMICODE_OPS_DIR: dir } as NodeJS.ProcessEnv);

  it("ZERO-CONFIG BYTE-IDENTITY: the create/prompt bodies carry no model key and the summary is today's", async () => {
    const { engine, by } = makeMockEngine();
    const def = CORE.AMICODE_TOOLS["amicode_session"]!;
    const result = await def.execute(
      { prompt: "map the frontier", count: 1, agent: "implementer" },
      { engineClient: engine, sessionID: "ses_parent", directory: "/w", carrier: "plugin" },
    );
    const created = by("create")[0]!;
    expect(created.body.agent).toBe("implementer");
    expect(created.body.model).toBeUndefined(); // byte-identity: no model key
    const prompted = by("promptAsync")[0]!;
    expect(prompted.body.model).toBeUndefined();
    expect(result).toMatch(/Spawned 1 fresh sessions/);
    expect(result).not.toMatch(/model routing/); // quiet when nothing is configured
  });

  it("the plugin twin behaves byte-identically under zero config", async () => {
    const { engine, by } = makeMockEngine();
    const pack = await pluginPack(engine);
    const result = await pack.tool["amicode_session"].execute(
      { prompt: "map the frontier", count: 1, agent: "implementer" },
      { sessionID: "ses_parent", directory: "/w" },
    );
    expect(by("create")[0]!.body.model).toBeUndefined();
    expect(result).not.toMatch(/model routing/);
  });

  it("a user-set row routes the spawn: the resolved model rides create + promptAsync, provenance surfaces in-line", async () => {
    writeUserSetRole(routingPrefsFile(env()), "implementer", "openai/gpt-5");
    writeProviderSnapshot(routingSnapshotFile(env()), ["openai"]);
    const { engine, by } = makeMockEngine();
    const def = CORE.AMICODE_TOOLS["amicode_session"]!;
    const result = await def.execute(
      { prompt: "implement the slice", count: 2, agent: "implementer" },
      { engineClient: engine, sessionID: "ses_parent", directory: "/w", carrier: "plugin" },
    );
    for (const c of by("create")) {
      expect(c.body.model).toEqual({ providerID: "openai", modelID: "gpt-5" });
      expect(c.body.agent).toBe("implementer");
    }
    for (const p of by("promptAsync")) {
      expect(p.body.model).toEqual({ providerID: "openai", modelID: "gpt-5" });
    }
    expect(result).toMatch(/\[model routing\] implementer → openai\/gpt-5 \(user-set\)/);
  });

  it("an explicit model arg is the hand-set for the dispatch — no routing, byte-identity", async () => {
    writeUserSetRole(routingPrefsFile(env()), "implementer", "zai/glm-5.3");
    writeProviderSnapshot(routingSnapshotFile(env()), ["zai"]);
    const { engine, by } = makeMockEngine();
    const def = CORE.AMICODE_TOOLS["amicode_session"]!;
    const result = await def.execute(
      { prompt: "x", count: 1, agent: "implementer", model: "openai/gpt-5" },
      { engineClient: engine, sessionID: "ses_parent", directory: "/w", carrier: "plugin" },
    );
    expect(by("create")[0]!.body.model).toEqual({ providerID: "openai", modelID: "gpt-5" });
    expect(result).not.toMatch(/model routing/);
  });

  it("a credential-driven downgrade is ANNOUNCED on the dispatch — named from → to", async () => {
    writeUserSetRole(routingPrefsFile(env()), "implementer", "zai/glm-5.3");
    setSuggestedOptIn(routingPrefsFile(env()), true);
    writeProviderSnapshot(routingSnapshotFile(env()), ["anthropic", "openai"]);
    const { engine, by } = makeMockEngine();
    const def = CORE.AMICODE_TOOLS["amicode_session"]!;
    const result = await def.execute(
      { prompt: "x", count: 1, agent: "implementer" },
      { engineClient: engine, sessionID: "ses_parent", directory: "/w", carrier: "plugin" },
    );
    const created = by("create")[0]!;
    // failed over to the first live suggestion in the card's prefer-list
    expect(created.body.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4-5" });
    expect(result).toMatch(/Model routing: implementer wanted zai\/glm-5\.3 \(user-set\)/);
    expect(result).toMatch(/no live credential for provider "zai"/);
    expect(result).toMatch(/dispatching anthropic\/claude-sonnet-4-5 \(suggested\)/);
  });

  it("an unannounced top-tier accept still notes the routing once (not per child)", async () => {
    writeUserSetRole(routingPrefsFile(env()), "implementer", "openai/gpt-5");
    writeProviderSnapshot(routingSnapshotFile(env()), ["openai"]);
    const { engine } = makeMockEngine();
    const def = CORE.AMICODE_TOOLS["amicode_session"]!;
    const result = await def.execute(
      { prompt: "x", count: 3, agent: "implementer" },
      { engineClient: engine, sessionID: "ses_parent", directory: "/w", carrier: "plugin" },
    );
    expect(result.match(/\[model routing\]/g)?.length).toBe(1);
  });

  it("opt-in false keeps suggestions display-only at the seam too — no model key, no note", async () => {
    setSuggestedOptIn(routingPrefsFile(env()), false);
    writeProviderSnapshot(routingSnapshotFile(env()), ["anthropic", "openai", "zai"]);
    const { engine, by } = makeMockEngine();
    const def = CORE.AMICODE_TOOLS["amicode_session"]!;
    const result = await def.execute(
      { prompt: "x", count: 1, agent: "implementer" },
      { engineClient: engine, sessionID: "ses_parent", directory: "/w", carrier: "plugin" },
    );
    expect(by("create")[0]!.body.model).toBeUndefined();
    expect(result).not.toMatch(/model routing/);
  });

  it("opt-in routes the suggestion class at the seam — the card's prefer-list resolves", async () => {
    setSuggestedOptIn(routingPrefsFile(env()), true);
    writeProviderSnapshot(routingSnapshotFile(env()), ["anthropic", "openai", "zai"]);
    const { engine, by } = makeMockEngine();
    const def = CORE.AMICODE_TOOLS["amicode_session"]!;
    await def.execute(
      { prompt: "x", count: 1, agent: "librarian" },
      { engineClient: engine, sessionID: "ses_parent", directory: "/w", carrier: "plugin" },
    );
    expect(by("create")[0]!.body.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4-5" });
  });

  it("fork mode carries the routed model on the prompt (the fork body stays bare — today's shape)", async () => {
    writeUserSetRole(routingPrefsFile(env()), "implementer", "openai/gpt-5");
    writeProviderSnapshot(routingSnapshotFile(env()), ["openai"]);
    const { engine, by } = makeMockEngine();
    const def = CORE.AMICODE_TOOLS["amicode_session"]!;
    await def.execute(
      { prompt: "branch here", count: 1, agent: "implementer", mode: "fork" },
      { engineClient: engine, sessionID: "ses_parent", directory: "/w", carrier: "plugin" },
    );
    expect(by("fork")).toHaveLength(1);
    expect(by("fork")[0]!.body.model).toBeUndefined(); // unchanged fork body
    expect(by("promptAsync")[0]!.body.model).toEqual({ providerID: "openai", modelID: "gpt-5" });
  });

  it("a re-dispatch after routing activates still creates — the gate coalesces in-flight only, never wedges", async () => {
    // one dispatch with routing, one without — different keys, both create
    writeProviderSnapshot(routingSnapshotFile(env()), ["openai"]);
    const { engine, by } = makeMockEngine();
    const def = CORE.AMICODE_TOOLS["amicode_session"]!;
    await def.execute(
      { prompt: "x", count: 1, agent: "implementer" },
      { engineClient: engine, sessionID: "ses_parent", directory: "/w", carrier: "plugin" },
    );
    writeUserSetRole(routingPrefsFile(env()), "implementer", "openai/gpt-5");
    await def.execute(
      { prompt: "x", count: 1, agent: "implementer" },
      { engineClient: engine, sessionID: "ses_parent", directory: "/w", carrier: "plugin" },
    );
    expect(by("create")).toHaveLength(2); // the second was a DIFFERENT dispatch — never coalesced
  });
});
