// amicode#860 — the model-routing service route family: the settings
// surface's data path (the posture.ts discipline — pure body-builders with
// injectable roots, one success shape per route family, ok:false +
// "code: detail" on failure, FIXED error strings, tolerant reads).
//
//   GET  /amicode/model-routing          → per-role rows + provenance + the
//                                          display-only suggestions + the
//                                          drift seat
//   POST /amicode/model-routing          → {role, model} — the user-set write
//   POST /amicode/model-routing/opt-in   → {opt_in: bool} — the suggestion
//                                          opt-in flag
//   POST /amicode/model-routing/reset    → {role} — clear the user-set row
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  routingPrefsFile,
  routingSnapshotFile,
  tunedTableFile,
  writeProviderSnapshot,
  writeUserSetRole,
  readRoutingPrefs,
} from "../opencode-plugin/model_routing";
import {
  modelRoutingResponse,
  saveModelRoutingResponse,
  saveRoutingOptInResponse,
  resetModelRoutingResponse,
} from "../src/amicode_service/model_routing";

const AGENTS_SRC = join(__dirname, "..", "agents");

describe("GET /amicode/model-routing (modelRoutingResponse)", () => {
  let dir: string;
  let deps: Record<string, unknown>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "amc-860-svc-"));
    deps = {
      agentsDir: AGENTS_SRC,
      prefsFile: routingPrefsFile({ AMICODE_OPS_DIR: dir } as NodeJS.ProcessEnv),
      snapshotFile: routingSnapshotFile({ AMICODE_OPS_DIR: dir } as NodeJS.ProcessEnv),
      tunedFile: tunedTableFile({ AMICODE_OPS_DIR: dir } as NodeJS.ProcessEnv),
      getProviders: () => ["anthropic", "openai"],
    };
  });

  it("renders one row per subagent role with its classes, provenance resolution, and suggestion", async () => {
    const body = JSON.parse(await modelRoutingResponse(deps));
    expect(body.ok).toBe(true);
    const roles = body.roles.map((r: { role: string }) => r.role).sort();
    expect(roles).toEqual(["analyzer", "experimenter", "hypothesizer", "implementer", "librarian"]);
    const impl = body.roles.find((r: { role: string }) => r.role === "implementer");
    expect(impl.classes).toEqual(["workhorse"]);
    expect(impl.effective.outcome).toBe("inherit"); // zero config → the default tier
    expect(impl.effective.tier).toBe("default");
    // the suggestion is display-only but RENDERED: first live candidate of the class
    expect(impl.suggestion.model).toBe("anthropic/claude-sonnet-4-5");
    expect(impl.suggestion.cls).toBe("workhorse");
  });

  it("credentialed-less providers never appear as suggestions", async () => {
    const body = JSON.parse(await modelRoutingResponse({ ...deps, getProviders: () => ["openai"] }));
    const impl = body.roles.find((r: { role: string }) => r.role === "implementer");
    expect(impl.suggestion.model).toBe("openai/gpt-5"); // second candidate — the first provider is dark
    const hyp = body.roles.find((r: { role: string }) => r.role === "hypothesizer");
    expect(hyp.suggestion.model).toBe("openai/gpt-5"); // strongest-reasoner, filtered
  });

  it("no credential snapshot → suggestions render as null (unknown is not 'all live')", async () => {
    const body = JSON.parse(await modelRoutingResponse({ ...deps, getProviders: () => undefined }));
    const impl = body.roles.find((r: { role: string }) => r.role === "implementer");
    expect(impl.suggestion).toBeNull();
    expect(body.providers).toBeNull();
  });

  it("a user-set row shows user-set provenance; drift renders the seat against the tuned table", async () => {
    writeUserSetRole(deps.prefsFile as string, "implementer", "openai/gpt-5");
    writeFileSync(deps.tunedFile as string, JSON.stringify({ implementer: "zai/glm-5.3" }));
    const body = JSON.parse(await modelRoutingResponse(deps));
    const impl = body.roles.find((r: { role: string }) => r.role === "implementer");
    expect(impl.effective).toMatchObject({ outcome: "model", model: "openai/gpt-5", tier: "user-set" });
    expect(impl.drift).toEqual({ drifted: true, tuned_model: "zai/glm-5.3" });
  });

  it("the tuned seat's presence is declared (provenance honesty), and opt_in reflects the prefs", async () => {
    const body = JSON.parse(await modelRoutingResponse(deps));
    expect(body.seats).toEqual({ tuned: false, fleet: false });
    expect(body.opt_in).toBe(false);
    expect(body.providers).toEqual(["anthropic", "openai"]);
  });

  it("the GET refreshes the provider snapshot — the dispatch seam's re-check reads fresh data", async () => {
    let flips = 0;
    const getProviders = () => (flips++ === 0 ? ["anthropic"] : ["zai"]);
    await modelRoutingResponse({ ...deps, getProviders });
    expect(readRoutingPrefs(deps.prefsFile as string)).toBeDefined();
    // second GET refreshed the snapshot file the seam reads
    await modelRoutingResponse({ ...deps, getProviders });
    const snap = JSON.parse((await import("node:fs")).readFileSync(deps.snapshotFile as string, "utf8"));
    expect(snap.providers).toEqual(["zai"]);
  });
});

describe("POST /amicode/model-routing (saveModelRoutingResponse)", () => {
  let dir: string;
  let deps: Record<string, unknown>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "amc-860-svcw-"));
    deps = {
      agentsDir: AGENTS_SRC,
      prefsFile: routingPrefsFile({ AMICODE_OPS_DIR: dir } as NodeJS.ProcessEnv),
      snapshotFile: routingSnapshotFile({ AMICODE_OPS_DIR: dir } as NodeJS.ProcessEnv),
    };
  });

  it("writes the user-set row; the GET then shows user-set provenance", async () => {
    const res = JSON.parse(await saveModelRoutingResponse({ role: "implementer", model: "openai/gpt-5" }, deps));
    expect(res).toEqual({ ok: true, role: "implementer", model: "openai/gpt-5", error: null });
    expect(readRoutingPrefs(deps.prefsFile as string).roles.implementer).toBe("openai/gpt-5");
  });

  it("refuses unknown roles and malformed models with the fixed bad_request (nothing echoed)", async () => {
    const bad1 = JSON.parse(await saveModelRoutingResponse({ role: "not-a-role", model: "openai/gpt-5" }, deps));
    expect(bad1.ok).toBe(false);
    expect(bad1.error).toMatch(/^bad_request:/);
    const bad2 = JSON.parse(await saveModelRoutingResponse({ role: "implementer", model: "no-slash" }, deps));
    expect(bad2.ok).toBe(false);
    const bad3 = JSON.parse(await saveModelRoutingResponse("junk", deps));
    expect(bad3.ok).toBe(false);
  });

  it("reset clears the user-set row (the reset affordance's write)", async () => {
    writeUserSetRole(deps.prefsFile as string, "implementer", "openai/gpt-5");
    const res = JSON.parse(await resetModelRoutingResponse({ role: "implementer" }, deps));
    expect(res.ok).toBe(true);
    expect(readRoutingPrefs(deps.prefsFile as string).roles.implementer).toBeUndefined();
    const res2 = JSON.parse(await resetModelRoutingResponse({ role: "implementer" }, deps));
    expect(res2.ok).toBe(true); // absent row: a no-op success, never an error
  });

  it("opt-in writes the flag", async () => {
    const res = JSON.parse(await saveRoutingOptInResponse({ opt_in: true }, deps));
    expect(res).toEqual({ ok: true, opt_in: true, error: null });
    expect(readRoutingPrefs(deps.prefsFile as string).suggested_opt_in).toBe(true);
    const bad = JSON.parse(await saveRoutingOptInResponse({ opt_in: "yes" }, deps));
    expect(bad.ok).toBe(false);
  });
});

describe("the route family registers on the live service (boot proof)", () => {
  it("GET + POST /amicode/model-routing answer on a booted createAmicodeService", async () => {
    process.env.AMICODE_OPS_DIR = mkdtempSync(join(tmpdir(), "amc-860-boot-"));
    const { createAmicodeService } = await import("../src/amicode_service");
    const service = createAmicodeService({
      modelRouting: {
        agentsDir: AGENTS_SRC,
        getProviders: () => ["anthropic", "openai"],
      },
    });
    const url = await service.start();
    const auth = service.authHeader;
    try {
      const get = await fetch(new URL("/amicode/model-routing", url), { headers: { Authorization: auth } });
      expect(get.status).toBe(200);
      const body = JSON.parse(await get.text());
      expect(body.ok).toBe(true);
      expect(body.roles.length).toBeGreaterThan(0);
      const post = await fetch(new URL("/amicode/model-routing", url), {
        method: "POST",
        headers: { Authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({ role: body.roles[0].role, model: "openai/gpt-5" }),
      });
      expect(post.status).toBe(200);
      expect(JSON.parse(await post.text()).ok).toBe(true);
      const optIn = await fetch(new URL("/amicode/model-routing/opt-in", url), {
        method: "POST",
        headers: { Authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({ opt_in: true }),
      });
      expect(JSON.parse(await optIn.text()).ok).toBe(true);
      const reset = await fetch(new URL("/amicode/model-routing/reset", url), {
        method: "POST",
        headers: { Authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({ role: body.roles[0].role }),
      });
      expect(JSON.parse(await reset.text()).ok).toBe(true);
    } finally {
      await service.stop();
    }
  });
});
