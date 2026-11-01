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
  firstPartyProvider,
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
    /** "provider/model" → catalog price (default 1.5/6) */
    prices: {} as Record<string, { input?: number; output?: number }>,
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
        Object.fromEntries(ids.map((id) => [id, { input: 1.5, output: 6, context: 200_000, ...(h.prices[`${p}/${id}`] ?? {}) }])),
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

// ── #2025: one arrival per model across unconnected resellers ──────────────
/** The live hub catalog (2026-10-30) for watch ["kimi-k3.1*"]: ONE model on six
 *  unconnected resellers → ten per-provider events before the collapse. */
const LIVE_KIMI: Record<string, string[]> = {
  "302ai": ["kimi-k3.1-pro"],
  llmgateway: ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"],
  "moonshotai-cn": ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"],
  moonshotai: ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"],
  "opencode-go": ["kimi-k3.1-pro"],
  requesty: ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"],
};

/** A harness whose catalog carries per-model prices and starts with the live
 *  kimi data on unconnected providers (anthropic is the only connected one). */
function liveHarness() {
  const h = harness({ watch: ["kimi-k3.1*"] });
  h.all = { anthropic: ["claude-a"], ...structuredClone(LIVE_KIMI) };
  h.connected = ["anthropic"];
  return h;
}

describe("watch collapse across unconnected providers (#2025)", () => {
  it("the live fixture (10 per-provider hits) yields exactly 2 arrivals, with also_on listing the rest", async () => {
    const h = liveHarness();
    await h.mr.tick();
    const got = await events(h);
    expect(got.map((e) => e.id).sort()).toEqual(["watch/kimi-k3.1-pro", "watch/kimi-k3.1-pro-highspeed"]);
    const pro = got.find((e) => e.id === "watch/kimi-k3.1-pro")!;
    expect(pro).toMatchObject({
      kind: "listed",
      watch: true,
      seen: false,
      status: "unchecked",
      reason: "provider not connected",
      // the first-party provider is the representative
      provider: "moonshotai",
      model: "kimi-k3.1-pro",
    });
    expect(pro.also_on).toEqual(["302ai", "llmgateway", "moonshotai-cn", "opencode-go", "requesty"]);
    const fast = got.find((e) => e.id === "watch/kimi-k3.1-pro-highspeed")!;
    expect(fast).toMatchObject({ provider: "moonshotai", model: "kimi-k3.1-pro-highspeed" });
    expect(fast.also_on).toEqual(["llmgateway", "moonshotai-cn", "requesty"]);
    // announced once, not every pass
    h.clock.now += 6 * MIN;
    await h.mr.tick();
    expect(await events(h)).toHaveLength(2);
  });

  it("takes the cheapest known price across the providers; a first-party-less model falls back to the cheapest provider", async () => {
    const h = liveHarness();
    h.all = { anthropic: ["claude-a"], "302ai": ["kimi-k3.1-pro"], requesty: ["kimi-k3.1-pro"], llmgateway: ["kimi-k3.1-pro"], moonshotai: ["kimi-k3.1-pro"] };
    h.prices = {
      "302ai/kimi-k3.1-pro": { input: 1, output: 3 },
      "requesty/kimi-k3.1-pro": { input: 0.4, output: 2 },
      "llmgateway/kimi-k3.1-pro": { input: 0.9, output: 2.5 },
      "moonshotai/kimi-k3.1-pro": { input: 0.6, output: 2.5 },
    };
    await h.mr.tick();
    const [pro] = await events(h);
    expect(pro).toMatchObject({ provider: "moonshotai", price: { input: 0.4, output: 2 } }); // cheapest price, first-party rep
    // no first-party reseller listed → the cheapest provider represents
    const h2 = liveHarness();
    h2.all = { anthropic: ["claude-a"], "302ai": ["kimi-k3.1-pro"], requesty: ["kimi-k3.1-pro"], llmgateway: ["kimi-k3.1-pro"] };
    h2.prices = h.prices;
    await h2.mr.tick();
    const [only] = await events(h2);
    expect(only).toMatchObject({ provider: "requesty", model: "kimi-k3.1-pro", price: { input: 0.4, output: 2 } });
    expect(only!.also_on).toEqual(["302ai", "llmgateway"]);
  });

  it("a connected-provider hit for the same model is its own event and wins over the collapsed one", async () => {
    const h = liveHarness();
    h.connected = ["anthropic", "requesty"]; // requesty is connected now
    await h.mr.tick(); // baseline for requesty
    const got = await events(h);
    const ids = got.map((e) => e.id).sort();
    // the connected hit keeps its per-provider id; the collapsed unconnected entries for the SAME base models are suppressed
    expect(ids).toEqual(["requesty/kimi-k3.1-pro", "requesty/kimi-k3.1-pro-highspeed"]);
    expect(got.every((e) => e.provider === "requesty" && e.watch)).toBe(true);
    expect(got.every((e) => e.also_on === undefined)).toBe(true);
  });

  it("an unconnected hit for a DIFFERENT model still collapses alongside a connected hit", async () => {
    const h = liveHarness();
    h.connected = ["anthropic", "requesty"];
    h.all.requesty = ["kimi-k3.1-pro"];
    h.all["302ai"] = ["kimi-k3.1-pro", "kimi-k3.1-mini"];
    await h.mr.tick();
    const ids = (await events(h)).map((e) => e.id).sort();
    expect(ids).toContain("requesty/kimi-k3.1-pro");
    expect(ids).toContain("watch/kimi-k3.1-mini");
    expect(ids).not.toContain("watch/kimi-k3.1-pro");
  });

  it("provider-qualified catalog ids collapse onto the same base model", async () => {
    const h = harness({ watch: ["kimi-k3.1*"] });
    h.all = { anthropic: ["claude-a"], requesty: ["moonshot/kimi-k3.1-pro"], "302ai": ["kimi-k3.1-pro"] };
    h.connected = ["anthropic"];
    await h.mr.tick();
    const got = await events(h);
    expect(got).toHaveLength(1);
    expect(got[0]!.id).toBe("watch/kimi-k3.1-pro");
  });

  it("marking seen persists across a provider appearing in (or leaving) the list; the event is refreshed in place", async () => {
    const h = liveHarness();
    await h.mr.tick();
    const first = (await events(h)).find((e) => e.id === "watch/kimi-k3.1-pro")!;
    await h.arrivals.markSeen([first.id]);
    h.all.novita = ["kimi-k3.1-pro"]; // a NEW reseller lists it
    h.clock.now += 6 * MIN;
    await h.mr.tick();
    let got = (await events(h)).filter((e) => e.id === "watch/kimi-k3.1-pro");
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ seen: true, first_seen_at: first.first_seen_at });
    expect(got[0]!.also_on).toContain("novita");
    delete h.all["302ai"]; // one drops out
    h.clock.now += 6 * MIN;
    await h.mr.tick();
    got = (await events(h)).filter((e) => e.id === "watch/kimi-k3.1-pro");
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ seen: true });
    expect(got[0]!.also_on).not.toContain("302ai");
    expect((await events(h)).filter((e) => !e.seen).map((e) => e.id)).toEqual(["watch/kimi-k3.1-pro-highspeed"]);
  });

  it("first-party preference: gemini→google, claude→anthropic, glm→zai, gpt→openai", () => {
    expect(firstPartyProvider("kimi-k3.1-pro", ["requesty", "moonshotai"])).toBe("moonshotai");
    expect(firstPartyProvider("gemini-4-pro", ["requesty", "google", "moonshotai"])).toBe("google");
    expect(firstPartyProvider("claude-x", ["requesty", "anthropic"])).toBe("anthropic");
    expect(firstPartyProvider("glm-5.3", ["requesty", "zai"])).toBe("zai");
    expect(firstPartyProvider("kimi-k3.1-pro", ["requesty", "google"])).toBeUndefined();
  });
});

describe("legacy per-provider watch events fold into the collapsed id (#2025)", () => {
  const legacy = (provider: string, model: string, over: Record<string, unknown> = {}) => ({
    id: `${provider}/${model}`,
    provider,
    model,
    status: "unchecked",
    kind: "listed",
    reason: "provider not connected",
    first_seen_at: T0 - 1000,
    seen: false,
    watch: true,
    price: { input: 1, output: 3 },
    context: null,
    latency_ms: null,
    ...over,
  });

  it("the 10 stored per-provider events read back as 2 collapsed ones, keeping seen", async () => {
    const h = liveHarness();
    const stored = Object.entries(LIVE_KIMI).flatMap(([p, ms]) =>
      ms.map((m) => legacy(p, m, m === "kimi-k3.1-pro" && p === "moonshotai" ? { seen: true } : {})),
    );
    expect(stored).toHaveLength(10);
    writeFileSync(join(h.dir, "model-arrivals.json"), JSON.stringify({ version: 1, events: stored }));
    // folded on read, before any pass
    const got = await events(h);
    expect(got.map((e) => e.id).sort()).toEqual(["watch/kimi-k3.1-pro", "watch/kimi-k3.1-pro-highspeed"]);
    expect(got.find((e) => e.id === "watch/kimi-k3.1-pro")).toMatchObject({ seen: true, first_seen_at: T0 - 1000 });
    expect(got.find((e) => e.id === "watch/kimi-k3.1-pro-highspeed")).toMatchObject({ seen: false });
    // the next pass persists the migration without re-announcing or resetting seen
    await h.mr.tick();
    h.clock.now += 6 * MIN;
    await h.mr.tick();
    const disk = JSON.parse(readFileSync(join(h.dir, "model-arrivals.json"), "utf8"));
    expect(disk.events.map((e: { id: string }) => e.id).sort()).toEqual(["watch/kimi-k3.1-pro", "watch/kimi-k3.1-pro-highspeed"]);
    const pro = disk.events.find((e: { id: string }) => e.id === "watch/kimi-k3.1-pro");
    expect(pro).toMatchObject({ seen: true, first_seen_at: T0 - 1000, provider: "moonshotai" });
    expect(pro.also_on).toEqual(["302ai", "llmgateway", "moonshotai-cn", "opencode-go", "requesty"]);
  });

  it("does not fold connected-provider events (own ids, own probes)", async () => {
    const h = liveHarness();
    const keep = legacy("requesty", "kimi-k3.1-pro", { status: "denied", reason: "403", kind: "listed" });
    writeFileSync(join(h.dir, "model-arrivals.json"), JSON.stringify({ version: 1, events: [keep] }));
    expect((await events(h)).map((e) => e.id)).toEqual(["requesty/kimi-k3.1-pro"]);
  });

  it("marking a legacy id seen marks its collapsed event", async () => {
    const h = liveHarness();
    writeFileSync(join(h.dir, "model-arrivals.json"), JSON.stringify({ version: 1, events: [legacy("302ai", "kimi-k3.1-pro")] }));
    expect(await h.arrivals.markSeen(["302ai/kimi-k3.1-pro"])).toBe(1);
    expect((await events(h))[0]).toMatchObject({ id: "watch/kimi-k3.1-pro", seen: true });
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
