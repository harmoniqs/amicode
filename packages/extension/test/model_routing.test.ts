// amicode#860 — S3 subagent model routing (spec-20260907-011500 D3, rev 3):
// the routing policy resolver, the dispatch seam, and the prefs/snapshot
// plumbing. The invariants under test (the critics' convergent blockers):
//
//   - ZERO-CONFIG: the default tier is inherit-session-model — today's
//     dispatch, byte-identical; suggestions display-only until opt-in.
//   - UNIFORM CREDENTIAL GATE: suggestions AND the tuned overlay are
//     credential-filtered at resolution time — a model the user holds no
//     credential for never becomes effective policy (drops to the next
//     tier, named reason).
//   - FAILOVER = walk the candidate chain downward at dispatch time; the
//     resolved model + fallback reason are recorded and surfaced —
//     credential-driven downgrades are ANNOUNCED, never silent.
//   - A hand-set `model:` field on a role card outranks the entire chain
//     (it IS user-set for that card).
//   - PRECEDENCE: user-set > fleet-locked (fleet-spawned ONLY) > tuned >
//     suggested > default.
//
// The tuned table is a SEAT here (S4, amicissimo#399, supplies content);
// the fleet lock is a SEAT too (the Telaio deployment supplies it). Both
// resolve as absent today.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MODEL_CLASSES,
  MODEL_CLASS_CATALOG,
  parseModelRoutingLine,
  listSubagentRoles,
  suggestedClassesForRole,
  handSetCardModel,
  routingPrefsFile,
  routingSnapshotFile,
  readRoutingPrefs,
  writeUserSetRole,
  clearUserSetRole,
  setSuggestedOptIn,
  writeProviderSnapshot,
  readLiveProviders,
  resolveRoleRoute,
  driftOf,
  routeSpawnModel,
  type ResolveRouteInputs,
} from "../opencode-plugin/model_routing";

const AGENTS_SRC = join(__dirname, "..", "agents");

describe("the class vocabulary and the public catalog (classes, never assignments)", () => {
  it("exactly three model classes — workhorse / strongest-reasoner / fast-cheap", () => {
    expect([...MODEL_CLASSES]).toEqual(["workhorse", "strongest-reasoner", "fast-cheap"]);
  });

  it("the catalog maps every class to ordered concrete candidates (the credential filter's input)", () => {
    for (const cls of MODEL_CLASSES) {
      const list = MODEL_CLASS_CATALOG[cls];
      expect(list.length).toBeGreaterThan(0);
      for (const m of list) expect(m).toMatch(/^[^/]+\/[^/]+$/); // "provider/model"
    }
    // the classes never collapse into one candidate set — the classes are the point
    expect(MODEL_CLASS_CATALOG["fast-cheap"]).not.toEqual(MODEL_CLASS_CATALOG["strongest-reasoner"]);
  });
});

describe("the role cards' Model routing lines (the suggestion source)", () => {
  it("parses an ordered, deduped class prefer-list out of a routing line; prose is ignored", () => {
    expect(parseModelRoutingLine("Model routing, suggested: workhorse — disciplined writing, not heavy reasoning.")).toEqual([
      "workhorse",
    ]);
    expect(parseModelRoutingLine("Model routing, suggested: strongest-reasoner → workhorse — escalate only when the classification itself is hard.")).toEqual([
      "strongest-reasoner",
      "workhorse",
    ]);
    expect(parseModelRoutingLine("Model routing, default: workhorse, workhorse, fast-cheap")).toEqual([
      "workhorse",
      "fast-cheap",
    ]);
    expect(parseModelRoutingLine("no routing line here")).toEqual([]);
  });

  it("every subagent role card names at least one class — the slots are filled, not empty", () => {
    const roles = listSubagentRoles(AGENTS_SRC);
    // the shipped worker cards (mode: subagent), not the director mode cards
    expect(roles.sort()).toEqual(["analyzer", "experimenter", "hypothesizer", "implementer", "librarian"].sort());
    for (const role of roles) {
      expect(suggestedClassesForRole(AGENTS_SRC, role).length).toBeGreaterThan(0);
    }
  });

  it("class assignments follow the spec's shape: judgment roles reason, worker roles ride the workhorse", () => {
    expect(suggestedClassesForRole(AGENTS_SRC, "hypothesizer")).toContain("strongest-reasoner");
    expect(suggestedClassesForRole(AGENTS_SRC, "analyzer")).toContain("strongest-reasoner");
    expect(suggestedClassesForRole(AGENTS_SRC, "implementer")).toContain("workhorse");
    expect(suggestedClassesForRole(AGENTS_SRC, "experimenter")).toContain("workhorse");
    expect(suggestedClassesForRole(AGENTS_SRC, "librarian")).toContain("workhorse");
    // the director mode cards are NOT subagent roles — the picker routes them
    expect(listSubagentRoles(AGENTS_SRC)).not.toContain("develop");
    expect(listSubagentRoles(AGENTS_SRC)).not.toContain("research");
  });

  it("handSetCardModel reads the frontmatter model: field (the user-set-for-that-card tier)", () => {
    const dir = mkdtempSync(join(tmpdir(), "amc-860-cards-"));
    writeFileSync(join(dir, "a.md"), "---\nmode: subagent\nmodel: anthropic/claude-opus-4-1\n---\nbody\n");
    writeFileSync(join(dir, "b.md"), "---\nmode: subagent\n---\nbody\n");
    expect(handSetCardModel(dir, "a")).toBe("anthropic/claude-opus-4-1");
    expect(handSetCardModel(dir, "b")).toBeNull();
    expect(handSetCardModel(dir, "missing")).toBeNull();
    // a model: field without a provider half is not a routable model
    writeFileSync(join(dir, "c.md"), "---\nmode: subagent\nmodel: just-a-name\n---\nbody\n");
    expect(handSetCardModel(dir, "c")).toBeNull();
  });
});

describe("the ops-dir prefs (model-routing.json) — the user-set tier's home", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "amc-860-prefs-"))));

  it("routingPrefsFile honors $AMICODE_OPS_DIR (the ops-dir convention)", () => {
    expect(routingPrefsFile({ AMICODE_OPS_DIR: dir } as NodeJS.ProcessEnv)).toBe(join(dir, "model-routing.json"));
    const fallback = routingPrefsFile({} as NodeJS.ProcessEnv);
    expect(fallback).toContain("model-routing.json");
  });

  it("reads fail-safe: absent or corrupt file → the zero-config default (opt-in false, no rows)", () => {
    const prefs = readRoutingPrefs(join(dir, "model-routing.json"));
    expect(prefs).toEqual({ schema_version: 1, suggested_opt_in: false, roles: {} });
    writeFileSync(join(dir, "model-routing.json"), "{corrupt");
    expect(readRoutingPrefs(join(dir, "model-routing.json")).roles).toEqual({});
    expect(readRoutingPrefs(join(dir, "model-routing.json")).suggested_opt_in).toBe(false);
  });

  it("writeUserSetRole / clearUserSetRole round-trip without losing sibling rows or the opt-in flag", () => {
    const file = join(dir, "model-routing.json");
    setSuggestedOptIn(file, true);
    writeUserSetRole(file, "implementer", "openai/gpt-5");
    writeUserSetRole(file, "analyzer", "anthropic/claude-opus-4-1");
    let prefs = readRoutingPrefs(file);
    expect(prefs.suggested_opt_in).toBe(true);
    expect(prefs.roles).toEqual({ implementer: "openai/gpt-5", analyzer: "anthropic/claude-opus-4-1" });
    clearUserSetRole(file, "implementer");
    prefs = readRoutingPrefs(file);
    expect(prefs.roles).toEqual({ analyzer: "anthropic/claude-opus-4-1" });
    expect(prefs.suggested_opt_in).toBe(true);
  });
});

describe("the live-provider snapshot — the credential gate's input", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "amc-860-snap-"))));

  it("write/read round-trip; absent → undefined (unknown, never an empty lie)", () => {
    const file = routingSnapshotFile({ AMICODE_OPS_DIR: dir } as NodeJS.ProcessEnv);
    expect(readLiveProviders(file)).toBeUndefined();
    writeProviderSnapshot(file, ["anthropic", "openai"]);
    expect(readLiveProviders(file)).toEqual(["anthropic", "openai"]);
    expect(existsSync(file)).toBe(true);
  });
});

describe("resolveRoleRoute — the precedence matrix", () => {
  const base: ResolveRouteInputs = { role: "implementer", classes: ["workhorse"] };

  it("zero config → inherit-session-model (the default tier), empty chain, no announcement", () => {
    const r = resolveRoleRoute(base);
    expect(r.outcome).toBe("inherit");
    expect(r.model).toBeNull();
    expect(r.tier).toBe("default");
    expect(r.chain).toEqual([]);
    expect(r.announcement).toBeNull();
    expect(r.reason).toMatch(/session/i);
  });

  it("user-set outranks tuned, suggested, and the hand-set card model", () => {
    const r = resolveRoleRoute({
      ...base,
      prefs: { schema_version: 1, suggested_opt_in: true, roles: { implementer: "openai/gpt-5" } },
      handSetModel: "anthropic/claude-opus-4-1",
      tuned: { implementer: "zai/glm-5.3" },
      liveProviders: ["anthropic", "openai", "zai"],
    });
    expect(r.outcome).toBe("model");
    expect(r.model).toBe("openai/gpt-5");
    expect(r.tier).toBe("user-set");
    expect(r.announcement).toBeNull();
  });

  it("the hand-set card model outranks the ENTIRE chain when no prefs row exists — it IS user-set", () => {
    const r = resolveRoleRoute({
      ...base,
      handSetModel: "anthropic/claude-opus-4-1",
      tuned: { implementer: "zai/glm-5.3" },
      liveProviders: ["anthropic", "zai"],
    });
    expect(r.model).toBe("anthropic/claude-opus-4-1");
    expect(r.tier).toBe("user-set");
    expect(r.reason).toMatch(/hand-set/i);
  });

  it("fleet-locked wins for fleet-spawned dispatches — and NEVER applies to product-initiated work", () => {
    const fleet = { implementer: "zai/glm-5.3" };
    const tuned = { implementer: "openai/gpt-5" };
    const rFleet = resolveRoleRoute({
      ...base,
      fleetLocked: fleet,
      tuned,
      fleetSession: true,
      liveProviders: ["zai", "openai"],
    });
    expect(rFleet.model).toBe("zai/glm-5.3");
    expect(rFleet.tier).toBe("fleet-locked");
    const rProduct = resolveRoleRoute({ ...base, fleetLocked: fleet, tuned, fleetSession: false, liveProviders: ["zai", "openai"] });
    expect(rProduct.model).toBe("openai/gpt-5");
    expect(rProduct.tier).toBe("tuned");
  });

  it("tuned outranks suggested; the tuned model is credential-gated — no credential drops to the next tier with a named reason", () => {
    const r = resolveRoleRoute({
      ...base,
      tuned: { implementer: "zai/glm-5.3" },
      prefs: { schema_version: 1, suggested_opt_in: true, roles: {} },
      liveProviders: ["anthropic"],
    });
    expect(r.outcome).toBe("model");
    expect(r.model).toBe("anthropic/claude-sonnet-4-5"); // workhorse class, first credentialed candidate
    expect(r.tier).toBe("suggested");
    const skipped = r.chain.find((row) => row.tier === "tuned");
    expect(skipped?.state).toBe("skipped");
    expect(skipped?.reason).toMatch(/no live credential for provider "zai"/);
    // the downgrade is announced, never silent
    expect(r.announcement).toMatch(/zai\/glm-5\.3/);
    expect(r.announcement).toMatch(/anthropic\/claude-sonnet-4-5/);
  });

  it("suggestions apply at dispatch ONLY on opt-in — display-only otherwise (the zero-config fold)", () => {
    const creds = MODEL_CLASS_CATALOG["workhorse"].map((m) => m.split("/")[0]);
    const rOff = resolveRoleRoute({ ...base, prefs: { schema_version: 1, suggested_opt_in: false, roles: {} }, liveProviders: creds });
    expect(rOff.outcome).toBe("inherit");
    expect(rOff.chain).toEqual([]);
    const rOn = resolveRoleRoute({ ...base, prefs: { schema_version: 1, suggested_opt_in: true, roles: {} }, liveProviders: creds });
    expect(rOn.outcome).toBe("model");
    expect(rOn.tier).toBe("suggested");
    expect(rOn.model).toBe(MODEL_CLASS_CATALOG["workhorse"][0]);
  });

  it("credentialed-less providers never appear as effective suggestions — the gate walks within the class too", () => {
    const all = MODEL_CLASS_CATALOG["workhorse"];
    const r = resolveRoleRoute({
      ...base,
      classes: ["workhorse"],
      prefs: { schema_version: 1, suggested_opt_in: true, roles: {} },
      liveProviders: [all[1]!.split("/")[0]], // only the SECOND candidate's provider is live
    });
    expect(r.model).toBe(all[1]);
    expect(r.chain.filter((row) => row.tier === "suggested")).toHaveLength(all.length);
    expect(r.chain[0]?.state).toBe("skipped");
  });

  it("every suggestion row carries its class in the reason (the suggestion's provenance is named)", () => {
    const r = resolveRoleRoute({
      ...base,
      classes: ["workhorse", "fast-cheap"],
      prefs: { schema_version: 1, suggested_opt_in: true, roles: {} },
      liveProviders: [],
    });
    expect(r.outcome).toBe("inherit");
    for (const row of r.chain.filter((x) => x.tier === "suggested")) {
      expect(row.reason).toMatch(/class/);
    }
  });

  it("unknown credentials fail safe → inherit-session-model, named reason, announced when candidates existed", () => {
    const r = resolveRoleRoute({ ...base, tuned: { implementer: "zai/glm-5.3" }, liveProviders: undefined });
    expect(r.outcome).toBe("inherit");
    expect(r.tier).toBe("default");
    expect(r.reason).toMatch(/credential snapshot unavailable|unavailable/i);
    expect(r.announcement).not.toBeNull();
    // zero-config + unknown creds stays quiet: no candidates, no announcement
    const quiet = resolveRoleRoute(base);
    expect(quiet.announcement).toBeNull();
  });

  it("all candidates unavailable → inherit-session-model with the announced fallback", () => {
    const r = resolveRoleRoute({
      ...base,
      prefs: { schema_version: 1, suggested_opt_in: true, roles: {} },
      liveProviders: ["nonexistent"],
    });
    expect(r.outcome).toBe("inherit");
    expect(r.announcement).toMatch(/no candidate/i);
  });

  it("a user-set row whose credential lapsed keeps the row in the chain but fails over to the default tier, announced", () => {
    const r = resolveRoleRoute({
      ...base,
      prefs: { schema_version: 1, suggested_opt_in: false, roles: { implementer: "zai/glm-5.3" } },
      liveProviders: ["anthropic"],
    });
    expect(r.outcome).toBe("inherit");
    expect(r.tier).toBe("default");
    expect(r.announcement).toMatch(/zai\/glm-5\.3/);
    // the lapsed row stays recorded in the chain — visible, never dropped
    const userRow = r.chain.find((row) => row.tier === "user-set");
    expect(userRow?.state).toBe("skipped");
  });

  it("a lapsed user-set credential with opt-in rides the chain down to the live suggestion, announced", () => {
    const creds = MODEL_CLASS_CATALOG["workhorse"].map((m) => m.split("/")[0]);
    const r = resolveRoleRoute({
      ...base,
      prefs: { schema_version: 1, suggested_opt_in: true, roles: { implementer: "zai/glm-5.3" } },
      liveProviders: creds.filter((p) => p !== "zai"),
    });
    expect(r.outcome).toBe("model");
    expect(r.tier).toBe("suggested");
    expect(r.announcement).toMatch(/zai\/glm-5\.3/);
    expect(r.announcement).toMatch(/credential/i);
  });

  it("lapse keeps user-set rows in the CHAIN (recorded, visible) even when skipped — never dropped silently", () => {
    const r = resolveRoleRoute({
      ...base,
      prefs: { schema_version: 1, suggested_opt_in: true, roles: { implementer: "zai/glm-5.3" } },
      handSetModel: "openai/gpt-5",
      liveProviders: ["openai"],
    });
    const userRow = r.chain.find((row) => row.tier === "user-set");
    expect(userRow).toBeDefined();
    expect(userRow?.state).toBe("skipped");
    expect(userRow?.reason).toMatch(/no live credential for provider "zai"/);
    expect(r.model).toBe("openai/gpt-5");
  });
});

describe("the drift indicator (the user-set row diverging from the tuned default)", () => {
  it("a diverging user-set row shows drift + the tuned model (the reset-to-tuned seat)", () => {
    const d = driftOf("implementer", { schema_version: 1, suggested_opt_in: false, roles: { implementer: "openai/gpt-5" } }, { implementer: "zai/glm-5.3" });
    expect(d).toEqual({ drifted: true, tuned_model: "zai/glm-5.3" });
  });
  it("a matching row and a missing tuned table show no drift (the tuned seat is absent today)", () => {
    const match = driftOf("implementer", { schema_version: 1, suggested_opt_in: false, roles: { implementer: "zai/glm-5.3" } }, { implementer: "zai/glm-5.3" });
    expect(match).toEqual({ drifted: false, tuned_model: "zai/glm-5.3" });
    const absent = driftOf("implementer", { schema_version: 1, suggested_opt_in: false, roles: { implementer: "openai/gpt-5" } }, undefined);
    expect(absent).toEqual({ drifted: false, tuned_model: null });
  });
});

describe("routeSpawnModel — the dispatch seam", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "amc-860-seam-"));
  });

  it("ZERO-CONFIG BYTE-IDENTITY: no prefs, no snapshot → model null, resolution null (today's dispatch)", () => {
    const r = routeSpawnModel({ agent: "implementer", opsEnv: { AMICODE_OPS_DIR: dir } as NodeJS.ProcessEnv, agentsDir: AGENTS_SRC });
    expect(r.model).toBeNull();
    expect(r.resolution).toBeNull();
  });

  it("no agent (server default) → routing is never consulted", () => {
    const r = routeSpawnModel({ agent: null, opsEnv: { AMICODE_OPS_DIR: dir } as NodeJS.ProcessEnv, agentsDir: AGENTS_SRC });
    expect(r.model).toBeNull();
    expect(r.resolution).toBeNull();
  });

  it("an explicit model arg IS the hand-set for this dispatch — the resolver is unconsulted", () => {
    writeUserSetRole(join(dir, "model-routing.json"), "implementer", "zai/glm-5.3");
    writeProviderSnapshot(routingSnapshotFile({ AMICODE_OPS_DIR: dir } as NodeJS.ProcessEnv), ["zai"]);
    const r = routeSpawnModel({
      agent: "implementer",
      explicitModel: "openai/gpt-5",
      opsEnv: { AMICODE_OPS_DIR: dir } as NodeJS.ProcessEnv,
      agentsDir: AGENTS_SRC,
    });
    expect(r.model).toBeNull();
    expect(r.resolution).toBeNull();
  });

  it("a user-set row resolves through the seam — the resolved model + provenance come back", () => {
    writeUserSetRole(join(dir, "model-routing.json"), "implementer", "openai/gpt-5");
    writeProviderSnapshot(routingSnapshotFile({ AMICODE_OPS_DIR: dir } as NodeJS.ProcessEnv), ["openai"]);
    const r = routeSpawnModel({ agent: "implementer", opsEnv: { AMICODE_OPS_DIR: dir } as NodeJS.ProcessEnv, agentsDir: AGENTS_SRC });
    expect(r.model).toEqual({ providerID: "openai", modelID: "gpt-5" });
    expect(r.resolution?.tier).toBe("user-set");
    expect(r.resolution?.announcement).toBeNull();
  });

  it("a mid-dispatch credential lapse fails over and the resolution carries the announcement", () => {
    writeUserSetRole(join(dir, "model-routing.json"), "implementer", "zai/glm-5.3");
    writeProviderSnapshot(routingSnapshotFile({ AMICODE_OPS_DIR: dir } as NodeJS.ProcessEnv), ["anthropic"]);
    const r = routeSpawnModel({ agent: "implementer", opsEnv: { AMICODE_OPS_DIR: dir } as NodeJS.ProcessEnv, agentsDir: AGENTS_SRC });
    // opt-in is false here, so the walk ends at the default tier — announced
    expect(r.model).toBeNull();
    expect(r.resolution?.outcome).toBe("inherit");
    expect(r.resolution?.announcement).toMatch(/zai\/glm-5\.3/);
  });

  it("any resolver throw fails safe to today's dispatch (never blocks a spawn)", () => {
    const r = routeSpawnModel({
      agent: "implementer",
      opsEnv: { AMICODE_OPS_DIR: join(dir, "does-not-exist", "deep") } as NodeJS.ProcessEnv,
      agentsDir: join(dir, "no-agents-here"),
    });
    expect(r.model).toBeNull();
    expect(r.resolution).toBeNull();
  });
});
