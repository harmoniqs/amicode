// amicode#655 — the double session-create guard.
//
// A single spawn dispatch must never create two live sessions: the
// amicode_session execute ran its create loop once per EXECUTE, with no
// idempotency gate between the tool-call boundary and
// engineClient.session.create / session.fork — so a re-fired dispatch (an
// engine tool-call retry racing the slow promptAsync, double registration,
// parallel callers) produced a second identical session, each ingesting its
// own copy of the same prompt and both burning model budget (#655).
//
// The fix: an IN-FLIGHT gate in the spawn policy (session_spawn.ts) —
// concurrent dispatches of the SAME spawn signature (same calling session,
// same parsed args) coalesce onto the first run; once it settles the entry is
// gone, so a deliberate sequential re-spawn still creates.
//
// Three layers are pinned here:
//   1. the pure gate (createSpawnGate / spawnGateKey) — hermetic instances;
//   2. the CORE tool's execute with a mock engine client — one concurrent
//      double-dispatch, one create;
//   3. the PLUGIN twin's execute with a mock engine client (the transport
//      that was live when #655 fired) — same guarantee.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AMICODE_PROBLEMS_DIR = mkdtempSync(join(tmpdir(), "amicode-655-"));

import {
  parseSpawnArgs,
  spawnGate,
  spawnGateKey,
  createSpawnGate,
} from "../opencode-plugin/session_spawn";
import type { AmicodeToolContext } from "../src/amicode_tools_core";

const CORE = await import("../src/amicode_tools_core");
const PLUGIN = await import("../opencode-plugin/amicode_tools");

/** A mock engine client: counts every session.create / session.fork so the
 * tests can assert "one logical spawn = one create" directly. Bare payloads
 * (no {data} envelope) exercise unwrap's passthrough branch. */
function makeMockEngine() {
  const calls: { create: number; fork: number; prompt: number } = { create: 0, fork: 0, prompt: 0 };
  const engine = {
    session: {
      get: async () => ({ id: "ses_parent", metadata: undefined, model: undefined }),
      create: async () => {
        calls.create += 1;
        return { id: `ses_child_${calls.create}` };
      },
      update: async () => ({}),
      fork: async () => {
        calls.fork += 1;
        return { id: `ses_fork_${calls.fork}` };
      },
      promptAsync: async () => {
        calls.prompt += 1;
        return {};
      },
    },
  };
  return { engine, calls };
}

describe("the spawn gate (pure policy, #655)", () => {
  it("spawnGateKey keys on the calling session + the full parsed signature", () => {
    const a = parseSpawnArgs({ prompt: "map the frontier", count: 1, mode: "fresh", force: false });
    if (!a.ok) throw new Error("parse failed");
    // Two spellings of the same spawn (count omitted vs explicit 1) parse to
    // the same args — a re-serialized retry must land on the SAME key.
    const b = parseSpawnArgs({ prompt: "map the frontier" });
    if (!b.ok) throw new Error("parse failed");
    expect(spawnGateKey("ses_a", "/w", a.args)).toBe(spawnGateKey("ses_a", "/w", b.args));
    // Different callers, prompts, modes, or force never share a key.
    expect(spawnGateKey("ses_a", "/w", a.args)).not.toBe(spawnGateKey("ses_b", "/w", a.args));
    expect(spawnGateKey("ses_a", "/w", a.args)).not.toBe(spawnGateKey("ses_a", "/w", { ...a.args, prompt: "other" }));
    expect(spawnGateKey("ses_a", "/w", a.args)).not.toBe(spawnGateKey("ses_a", "/w", { ...a.args, mode: "fork" }));
    expect(spawnGateKey("ses_a", "/w", a.args)).not.toBe(spawnGateKey("ses_a", "/w", { ...a.args, force: true }));
  });

  it("coalesces concurrent identical runs onto the first — the runner fires once", async () => {
    const gate = createSpawnGate();
    let runs = 0;
    const run = async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 20));
      return `ran-${runs}`;
    };
    const [x, y] = await Promise.all([gate.coalesce("k", run), gate.coalesce("k", run)]);
    expect(runs).toBe(1);
    expect(x).toBe("ran-1");
    expect(y).toBe("ran-1"); // the follower gets the FIRST run's result, not a second run
  });

  it("different keys run independently (parallel work is the feature, not the bug)", async () => {
    const gate = createSpawnGate();
    let runs = 0;
    const run = async () => {
      const n = runs + 1;
      runs = n;
      await new Promise((r) => setTimeout(r, 20));
      return `ran-${n}`;
    };
    const [x, y] = await Promise.all([gate.coalesce("k1", run), gate.coalesce("k2", run)]);
    expect(runs).toBe(2);
    expect(new Set([x, y]).size).toBe(2);
  });

  it("is IN-FLIGHT ONLY — once the first run settles, the same key runs again", async () => {
    const gate = createSpawnGate();
    let runs = 0;
    const run = async () => {
      runs += 1;
      return `ran-${runs}`;
    };
    expect(await gate.coalesce("k", run)).toBe("ran-1");
    expect(await gate.coalesce("k", run)).toBe("ran-2"); // deliberate sequential re-spawn still spawns
  });

  it("a rejected run clears the gate — a later dispatch retries instead of a dead coalesce", async () => {
    const gate = createSpawnGate();
    let runs = 0;
    const boom = async () => {
      runs += 1;
      throw new Error("engine hiccup");
    };
    await expect(gate.coalesce("k", boom)).rejects.toThrow("engine hiccup");
    await expect(gate.coalesce("k", boom)).rejects.toThrow("engine hiccup");
    expect(runs).toBe(2); // both attempts ran — the rejection never wedged the key
  });

  it("exposes a transport-wide singleton (both twins gate through it)", () => {
    expect(typeof spawnGate.coalesce).toBe("function");
  });
});

describe("amicode_session double-create guard (#655) — the CORE tool", () => {
  const def = () => CORE.AMICODE_TOOLS["amicode_session"] as (typeof CORE.AMICODE_TOOLS)["amicode_session"];

  it("one concurrent double-dispatch of the same spawn creates ONE session", async () => {
    const { engine, calls } = makeMockEngine();
    const ctx: AmicodeToolContext = { engineClient: engine, sessionID: "ses_parent", directory: "/w", carrier: "plugin" };
    const args = { prompt: "map the frontier", count: 1, mode: "fresh", force: false };
    const [r1, r2] = await Promise.all([def().execute(args, ctx), def().execute(args, ctx)]);
    expect(calls.create).toBe(1);
    expect(calls.prompt).toBe(1); // one child ingests the prompt once
    expect(r1).toBe(r2); // both dispatches see the same honest summary + child id
    expect(r1).toMatch(/ses_child_1/);
    expect(r1).toMatch(/Spawned 1 fresh sessions/);
  });

  it("the same gate holds for fork mode (a re-fired fork must not fork twice)", async () => {
    const { engine, calls } = makeMockEngine();
    const ctx: AmicodeToolContext = { engineClient: engine, sessionID: "ses_parent", directory: "/w", carrier: "plugin" };
    const args = { prompt: "branch here", count: 1, mode: "fork", force: false };
    const [r1, r2] = await Promise.all([def().execute(args, ctx), def().execute(args, ctx)]);
    expect(calls.fork).toBe(1);
    expect(r1).toBe(r2);
    expect(r1).toMatch(/forked from this session's history/);
  });

  it("different parents spawning the same prompt concurrently both create (parallel fan-out preserved)", async () => {
    const { engine, calls } = makeMockEngine();
    const a1 = def().execute({ prompt: "same work", count: 1 }, { engineClient: engine, sessionID: "ses_p1", directory: "/w" });
    const a2 = def().execute({ prompt: "same work", count: 1 }, { engineClient: engine, sessionID: "ses_p2", directory: "/w" });
    const [r1, r2] = await Promise.all([a1, a2]);
    expect(calls.create).toBe(2);
    expect(r1).toMatch(/ses_child_1/);
    expect(r2).toMatch(/ses_child_2/);
  });

  it("a DELIBERATE sequential re-spawn of the same prompt still creates (in-flight only)", async () => {
    const { engine, calls } = makeMockEngine();
    const ctx: AmicodeToolContext = { engineClient: engine, sessionID: "ses_parent", directory: "/w" };
    const args = { prompt: "map the frontier", count: 1 };
    await def().execute(args, ctx);
    await def().execute(args, ctx);
    expect(calls.create).toBe(2);
  });
});

describe("amicode_session double-create guard (#655) — the PLUGIN twin (the live transport at bug time)", () => {
  it("one concurrent double-dispatch through the plugin transport creates ONE session", async () => {
    const { engine, calls } = makeMockEngine();
    const pack = (await PLUGIN.AmicodeTools({ client: engine })) as {
      tool: Record<string, { execute: (a: unknown, ctx: unknown) => Promise<string> }>;
    };
    const spawn = pack.tool["amicode_session"];
    const args = { prompt: "map the frontier", count: 1, mode: "fresh", force: false };
    const ctx = { sessionID: "ses_parent", directory: "/w" };
    const [r1, r2] = await Promise.all([spawn.execute(args, ctx), spawn.execute(args, ctx)]);
    expect(calls.create).toBe(1);
    expect(calls.prompt).toBe(1);
    expect(r1).toBe(r2);
    expect(r1).toMatch(/ses_child_1/);
  });
});
