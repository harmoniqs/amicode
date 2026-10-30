// #2000: model arrivals — the catalog diff per connected provider, the
// watchlist, the events store + routes. Drives a FAKE catalog + FAKE probe
// through the real ModelReachability scheduler (the arrivals pass is its tick
// hook), so the rate-limit claim, the sibling snapshot file and the baseline
// rules are all the production ones.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ModelReachability,
  type CatalogInfo,
  type ProbeOutput,
  type ProbeStatus,
} from "../src/amicode_service/model_reachability";
import {
  ModelArrivals,
  arrivalKind,
  baseModelId,
  globMatches,
  markSeenResponse,
  modelArrivalsResponse,
} from "../src/amicode_service/model_arrivals";

const T0 = 1_800_000_000_000;
const MIN = 60_000;

function harness(opts: { watch?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "amc-2000-"));
  const h = {
    dir,
    clock: { now: T0 },
    /** provider → model ids */
    all: {
      anthropic: ["claude-a"],
      "amazon-bedrock": ["us.anthropic.claude-b"],
      moonshotai: ["kimi-k3"],
      google: ["gemini-3"],
    } as Record<string, string[]>,
    connected: ["anthropic", "amazon-bedrock", "moonshotai"] as string[],
    statuses: {} as Record<string, ProbeStatus>,
    reasons: {} as Record<string, string>,
    watch: opts.watch ?? ([] as string[]),
    probes: [] as Array<{ provider: string; ids: string[] }>,
    mr: undefined as unknown as ModelReachability,
    arrivals: undefined as unknown as ModelArrivals,
    snapshotFile: join(dir, "model-catalog-snapshot.json"),
  };
  const catalog = async (): Promise<CatalogInfo> => ({
    connected: [...h.connected],
    providers: Object.fromEntries(
      Object.entries(h.all).map(([p, ids]) => [
        p,
        Object.fromEntries(ids.map((id) => [id, { input: 1.5, output: 6, context: 200_000 }])),
      ]),
    ),
  });
  h.mr = new ModelReachability({
    file: join(dir, "model-reachability.json"),
    now: () => h.clock.now,
    schedulerIntervalMs: 0,
    listModels: async () => Object.fromEntries(h.connected.map((p) => [p, [...(h.all[p] ?? [])]])),
    listCatalog: catalog,
    getWatch: () => h.watch,
    probe: async (provider: string, ids: string[]): Promise<ProbeOutput> => {
      h.probes.push({ provider, ids: [...ids] });
      return {
        providerID: provider,
        results: ids.map((model) => ({
          model,
          status: h.statuses[`${provider}/${model}`] ?? "ok",
          latency_ms: 420,
          reason: h.reasons[`${provider}/${model}`] ?? null,
          credential_fp: "fp1",
          checked_at: h.clock.now,
        })),
      };
    },
  });
  h.arrivals = new ModelArrivals({ reachability: h.mr, now: () => h.clock.now });
  h.mr.onTick(() => h.arrivals.pass());
  return h;
}

const events = async (h: ReturnType<typeof harness>) => (await h.arrivals.list()).arrivals;

describe("catalog diff (#2000)", () => {
  it("the first-ever run records a baseline silently — no events", async () => {
    const h = harness();
    await h.mr.tick();
    expect(await events(h)).toEqual([]);
    const snap = JSON.parse(readFileSync(h.snapshotFile, "utf8"));
    expect(snap.providers["amazon-bedrock"]).toEqual(["us.anthropic.claude-b"]);
    expect(snap.providers.google).toBeUndefined(); // unconnected: not snapshotted
  });

  it("the snapshot is a sibling of the reachability cache file", async () => {
    const h = harness();
    await h.mr.tick();
    expect(h.snapshotFile).toBe(join(h.dir, "model-catalog-snapshot.json"));
    expect(existsSync(h.snapshotFile)).toBe(true);
  });

  it("gemini-4-carbon (bedrock, denied by IAM) + kimi-k3.1-pro (moonshotai, ok) → exactly two events with the right kinds; a second refresh emits none", async () => {
    const h = harness();
    await h.mr.tick();
    h.all["amazon-bedrock"]!.push("us.google.gemini-4-carbon");
    h.all.moonshotai!.push("kimi-k3.1-pro");
    h.statuses["amazon-bedrock/us.google.gemini-4-carbon"] = "denied";
    h.reasons["amazon-bedrock/us.google.gemini-4-carbon"] =
      "User: arn:aws:sts::1:assumed-role/x is not authorized to perform: bedrock:InvokeModel";
    h.clock.now += 6 * MIN; // past the per-provider probe floor
    await h.mr.tick();
    const got = await events(h);
    expect(got).toHaveLength(2);
    const bedrock = got.find((e) => e.provider === "amazon-bedrock")!;
    const kimi = got.find((e) => e.provider === "moonshotai")!;
    expect(bedrock).toMatchObject({
      model: "us.google.gemini-4-carbon",
      status: "denied",
      kind: "needs-allowlist",
      seen: false,
      watch: false,
      first_seen_at: h.clock.now,
    });
    expect(kimi).toMatchObject({ model: "kimi-k3.1-pro", status: "ok", kind: "available", price: { input: 1.5, output: 6 }, context: 200_000 });
    // only the NEW ids were probed
    expect(h.probes.filter((p) => p.ids.includes("kimi-k3.1-pro"))[0]!.ids).toEqual(["kimi-k3.1-pro"]);

    h.clock.now += 6 * MIN;
    await h.mr.tick();
    expect(await events(h)).toHaveLength(2);
    expect((await events(h)).every((e) => e.first_seen_at === got.find((g) => g.id === e.id)!.first_seen_at)).toBe(true);
  });

  it("us./global./eu. variants of one base id announce once", async () => {
    const h = harness();
    await h.mr.tick();
    h.all["amazon-bedrock"]!.push("us.google.gemini-4-carbon", "global.google.gemini-4-carbon", "eu.google.gemini-4-carbon");
    h.statuses["amazon-bedrock/us.google.gemini-4-carbon"] = "denied";
    h.reasons["amazon-bedrock/us.google.gemini-4-carbon"] = "AccessDeniedException: not authorized";
    h.clock.now += 6 * MIN;
    await h.mr.tick();
    const got = await events(h);
    expect(got).toHaveLength(1);
    // a variant arriving LATER for an announced base stays silent
    h.all["amazon-bedrock"]!.push("apac.google.gemini-4-carbon");
    h.clock.now += 6 * MIN;
    await h.mr.tick();
    expect(await events(h)).toHaveLength(1);
  });

  it("a variant that is callable wins the representative slot", async () => {
    const h = harness();
    await h.mr.tick();
    h.all["amazon-bedrock"]!.push("us.google.gemini-4-carbon", "global.google.gemini-4-carbon");
    h.statuses["amazon-bedrock/us.google.gemini-4-carbon"] = "denied";
    h.clock.now += 6 * MIN;
    await h.mr.tick();
    const [e] = await events(h);
    expect(e).toMatchObject({ model: "global.google.gemini-4-carbon", kind: "available", status: "ok" });
  });

  it("'not available for this account' → needs-agreement", async () => {
    const h = harness();
    await h.mr.tick();
    h.all["amazon-bedrock"]!.push("us.zai.glm-5.3");
    h.statuses["amazon-bedrock/us.zai.glm-5.3"] = "unavailable";
    h.reasons["amazon-bedrock/us.zai.glm-5.3"] = "This model is not available for this account; subscribe via AWS Marketplace";
    h.clock.now += 6 * MIN;
    await h.mr.tick();
    expect((await events(h))[0]).toMatchObject({ kind: "needs-agreement" });
  });

  it("a new id inside the probe floor stays pending (no event, no snapshot) and is announced next pass", async () => {
    const h = harness();
    await h.mr.tick();
    h.all.moonshotai!.push("kimi-k3.1-pro");
    h.clock.now += 1 * MIN; // inside the 5-min floor
    await h.mr.tick();
    expect(await events(h)).toEqual([]);
    h.clock.now += 6 * MIN;
    await h.mr.tick();
    expect(await events(h)).toHaveLength(1);
  });

  it("removing a model id from the snapshot makes it re-announce once", async () => {
    const h = harness();
    await h.mr.tick();
    h.all.moonshotai!.push("kimi-k3.1-pro");
    h.clock.now += 6 * MIN;
    await h.mr.tick();
    const first = (await events(h))[0]!;
    await h.arrivals.markSeen([first.id]);
    const snap = JSON.parse(readFileSync(h.snapshotFile, "utf8"));
    snap.providers.moonshotai = snap.providers.moonshotai.filter((m: string) => m !== "kimi-k3.1-pro");
    writeFileSync(h.snapshotFile, JSON.stringify(snap));
    h.clock.now += 6 * MIN;
    await h.mr.tick();
    const again = await events(h);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ id: first.id, seen: false });
    h.clock.now += 6 * MIN;
    await h.mr.tick();
    expect(await events(h)).toHaveLength(1);
  });

  it("a newly connected provider is a silent baseline, not an arrival flood", async () => {
    const h = harness();
    await h.mr.tick();
    h.connected.push("google");
    h.clock.now += 6 * MIN;
    await h.mr.tick();
    expect(await events(h)).toEqual([]);
  });
});

describe("watchlist (#2000)", () => {
  it("a glob matches across ALL providers; a watched model on an unconnected provider is announced as listed", async () => {
    const h = harness({ watch: ["gemini-4-carbon*"] });
    await h.mr.tick();
    h.all.google!.push("gemini-4-carbon-preview");
    h.all["amazon-bedrock"]!.push("us.google.gemini-4-carbon");
    h.statuses["amazon-bedrock/us.google.gemini-4-carbon"] = "denied";
    h.reasons["amazon-bedrock/us.google.gemini-4-carbon"] = "not authorized to perform bedrock:InvokeModel";
    h.clock.now += 6 * MIN;
    await h.mr.tick();
    const got = await events(h);
    expect(got).toHaveLength(2);
    const google = got.find((e) => e.provider === "google")!;
    expect(google).toMatchObject({ kind: "listed", watch: true, status: "unchecked" });
    expect(google.reason).toMatch(/not connected/);
    expect(got.find((e) => e.provider === "amazon-bedrock")).toMatchObject({ kind: "needs-allowlist", watch: true });
    // the watch hit on the unconnected provider is announced once, not every pass
    h.clock.now += 6 * MIN;
    await h.mr.tick();
    expect(await events(h)).toHaveLength(2);
  });

  it("an unwatched model on an unconnected provider emits nothing", async () => {
    const h = harness({ watch: ["gemini-4-carbon*"] });
    await h.mr.tick();
    h.all.google!.push("gemini-4-flash");
    h.clock.now += 6 * MIN;
    await h.mr.tick();
    expect(await events(h)).toEqual([]);
  });

  it("with no watchlist nothing on an unconnected provider is ever announced", async () => {
    const h = harness();
    await h.mr.tick();
    h.all.google!.push("gemini-4-carbon");
    h.clock.now += 6 * MIN;
    await h.mr.tick();
    expect(await events(h)).toEqual([]);
  });
});

describe("pure helpers", () => {
  it("baseModelId strips regional inference prefixes only", () => {
    expect(baseModelId("us.anthropic.claude-x")).toBe("anthropic.claude-x");
    expect(baseModelId("global.anthropic.claude-x")).toBe("anthropic.claude-x");
    expect(baseModelId("eu.anthropic.claude-x")).toBe("anthropic.claude-x");
    expect(baseModelId("kimi-k3")).toBe("kimi-k3");
    expect(baseModelId("users.model")).toBe("users.model");
  });
  it("globMatches: * and ?, case-insensitive, whole-string", () => {
    expect(globMatches("gemini-4-carbon*", "gemini-4-carbon-preview")).toBe(true);
    expect(globMatches("GEMINI-4-CARBON*", "gemini-4-carbon")).toBe(true);
    expect(globMatches("kimi-k3.1*", "kimi-k3.1-pro")).toBe(true);
    expect(globMatches("kimi-k3.1*", "kimi-k3x1-pro")).toBe(false); // "." is literal
    expect(globMatches("gemini-4-carbon", "gemini-4-carbon-preview")).toBe(false);
    expect(globMatches("gem?ni", "gemini")).toBe(true);
  });
  it("arrivalKind", () => {
    expect(arrivalKind("moonshotai", "ok", null)).toBe("available");
    expect(arrivalKind("amazon-bedrock", "denied", "AccessDenied")).toBe("needs-allowlist");
    expect(arrivalKind("amazon-bedrock", "unavailable", "not available for this account")).toBe("needs-agreement");
    expect(arrivalKind("amazon-bedrock", "unavailable", "Marketplace agreement required")).toBe("needs-agreement");
    expect(arrivalKind("openai", "denied", "403")).toBe("listed");
    expect(arrivalKind("openai", "unchecked", null)).toBe("listed");
  });
});

describe("routes (#2000)", () => {
  it("GET → {ok, arrivals[...]}; POST seen marks and the GET reflects it", async () => {
    const h = harness();
    await h.mr.tick();
    h.all.moonshotai!.push("kimi-k3.1-pro");
    h.clock.now += 6 * MIN;
    await h.mr.tick();
    const body = JSON.parse(await modelArrivalsResponse(h.arrivals));
    expect(body.ok).toBe(true);
    expect(body.error).toBeNull();
    expect(body.arrivals).toHaveLength(1);
    expect(Object.keys(body.arrivals[0])).toEqual(
      expect.arrayContaining(["id", "provider", "model", "status", "kind", "first_seen_at", "seen", "watch"]),
    );
    expect(body.unseen).toBe(1);
    const id = body.arrivals[0].id;
    const marked = JSON.parse(await markSeenResponse({ ids: [id, "nope"] }, h.arrivals));
    expect(marked).toEqual({ ok: true, marked: 1, error: null });
    const after = JSON.parse(await modelArrivalsResponse(h.arrivals));
    expect(after.arrivals[0].seen).toBe(true);
    expect(after.unseen).toBe(0);
  });

  it("POST seen rejects a malformed body with a fixed error", async () => {
    const h = harness();
    for (const bad of [{}, { ids: "x" }, { ids: [1] }, "{nope", { ids: Array.from({ length: 501 }, (_, i) => String(i)) }]) {
      const r = JSON.parse(await markSeenResponse(bad, h.arrivals));
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/^bad_request: /);
    }
  });

  it("caps the unseen at 20 and summarises the rest", async () => {
    const h = harness();
    await h.mr.tick();
    for (let i = 0; i < 25; i++) h.all.moonshotai!.push(`kimi-n${String(i).padStart(2, "0")}`);
    h.clock.now += 6 * MIN;
    await h.mr.tick();
    const body = JSON.parse(await modelArrivalsResponse(h.arrivals));
    expect(body.arrivals.filter((a: { seen: boolean }) => !a.seen)).toHaveLength(20);
    expect(body.unseen).toBe(25);
    expect(body.collapsed).toBe(5);
  });

  it("no events file → an empty, ok body", async () => {
    const h = harness();
    expect(JSON.parse(await modelArrivalsResponse(h.arrivals))).toEqual({
      ok: true,
      arrivals: [],
      unseen: 0,
      collapsed: 0,
      error: null,
    });
  });
});

describe("boot proof (#2000)", () => {
  it("GET/POST /amicode/model-arrivals answer on a booted service; an arrival lands via the scheduler tick", async () => {
    const prev = process.env.AMICODE_OPS_DIR;
    const ops = mkdtempSync(join(tmpdir(), "amc-2000-ops-"));
    process.env.AMICODE_OPS_DIR = ops;
    const { createAmicodeService } = await import("../src/amicode_service");
    const models = { moonshotai: ["kimi-k3"] as string[] };
    const service = createAmicodeService({
      modelReachability: {
        listModels: async () => structuredClone(models),
        listCatalog: async () => ({
          connected: ["moonshotai"],
          providers: { moonshotai: Object.fromEntries(models.moonshotai.map((m) => [m, {}])) },
        }),
        probe: async (providerID, ids) => ({
          providerID,
          results: ids.map((model) => ({ model, status: "ok" as const, latency_ms: 1, reason: null, credential_fp: "fp", checked_at: Date.now() })),
        }),
        minProbeIntervalMs: 0,
        schedulerIntervalMs: 30,
        schedulerInitialDelayMs: 5,
      },
    });
    const url = await service.start();
    const auth = service.authHeader;
    const get = async (p: string) => JSON.parse(await (await fetch(new URL(p, url), { headers: { Authorization: auth } })).text());
    try {
      expect((await get("/amicode/model-arrivals")).arrivals).toEqual([]);
      await new Promise((r) => setTimeout(r, 150)); // baseline recorded
      models.moonshotai.push("kimi-k3.1-pro");
      let body = await get("/amicode/model-arrivals");
      for (let i = 0; i < 40 && body.arrivals.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
        body = await get("/amicode/model-arrivals");
      }
      expect(body.arrivals).toHaveLength(1);
      expect(body.arrivals[0]).toMatchObject({ provider: "moonshotai", model: "kimi-k3.1-pro", kind: "available", seen: false });
      const seen = await fetch(new URL("/amicode/model-arrivals/seen", url), {
        method: "POST",
        headers: { Authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({ ids: [body.arrivals[0].id] }),
      });
      expect(JSON.parse(await seen.text())).toMatchObject({ ok: true, marked: 1 });
      expect((await get("/amicode/model-arrivals")).unseen).toBe(0);
      expect(existsSync(join(ops, "model-catalog-snapshot.json"))).toBe(true);
    } finally {
      await service.stop();
      if (prev === undefined) delete process.env.AMICODE_OPS_DIR;
      else process.env.AMICODE_OPS_DIR = prev;
    }
  });
});
