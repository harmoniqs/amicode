// #1985 (#1979 S2): the amicode service's model-reachability cache +
// scheduler + route family. The probe itself is S1's engine route
// (POST /provider/probe, #1984); every test here drives a FAKE probe so the
// cache / rate-limit / invalidation / locking semantics are pinned without an
// engine. The last groups boot the real service (createAmicodeService) and the
// headless hub runner (bootAmicodeServiceRunner over a fake engine) to prove
// the route family is wired on both paths — the hub runner skipped the
// model-routing wiring once; the reachability family must not repeat that.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ModelReachability,
  reachabilityCacheFile,
  modelReachabilityResponse,
  refreshModelReachabilityResponse,
  demoteModelReachabilityResponse,
  type ProbeOutput,
  type ProbeStatus,
} from "../src/amicode_service/model_reachability";
import { fetchProviderModels, probeProviderModels } from "../src/llm_creds.mjs";
import { bootAmicodeServiceRunner, type AmicodeServiceRunnerBoot } from "../src/amicode_service_runner";

interface Harness {
  file: string;
  clock: { now: number };
  fp: { current: string | null };
  statuses: Record<string, ProbeStatus>;
  catalog: Record<string, string[]>;
  calls: Array<{ providerID: string; modelIDs: string[] }>;
  make(overrides?: Partial<ConstructorParameters<typeof ModelReachability>[0]>): ModelReachability;
}

function harness(file?: string): Harness {
  const dir = mkdtempSync(join(tmpdir(), "amc-1985-"));
  const h: Harness = {
    file: file ?? join(dir, "model-reachability.json"),
    clock: { now: 1_800_000_000_000 },
    fp: { current: "aaaaaaaaaaaaaaaa" },
    statuses: {},
    catalog: { anthropic: ["claude-a", "claude-b"], openai: ["gpt-x"] },
    calls: [],
    make(overrides = {}) {
      return new ModelReachability({
        file: h.file,
        now: () => h.clock.now,
        listModels: async () => structuredClone(h.catalog),
        probe: async (providerID: string, modelIDs: string[]): Promise<ProbeOutput> => {
          h.calls.push({ providerID, modelIDs: [...modelIDs] });
          return {
            providerID,
            results: modelIDs.map((model) => ({
              model,
              status: h.statuses[`${providerID}/${model}`] ?? "ok",
              latency_ms: 7,
              reason: h.statuses[`${providerID}/${model}`] ? "fake reason" : null,
              credential_fp: h.fp.current,
              checked_at: h.clock.now,
            })),
          };
        },
        ...overrides,
      });
    },
  };
  return h;
}

const row = (snap: { models: Array<{ provider: string; model: string }> }, provider: string, model: string) =>
  snap.models.find((m) => m.provider === provider && m.model === model) as
    | { provider: string; model: string; status: string; reason: string | null; credential_fp: string | null; source: string | null }
    | undefined;

describe("unknown is unchecked, never ok", () => {
  it("a catalog model that was never probed is reported as unchecked", async () => {
    const h = harness();
    const snap = await h.make().snapshot();
    expect(snap.catalog_known).toBe(true);
    for (const m of snap.models) expect(m.status).toBe("unchecked");
    expect(row(snap, "anthropic", "claude-a")?.status).toBe("unchecked");
    expect(row(snap, "openai", "gpt-x")?.status).toBe("unchecked");
  });

  it("no catalog and no cache → no rows (nothing is invented), catalog_known false", async () => {
    const h = harness();
    const snap = await h.make({ listModels: async () => undefined }).snapshot();
    expect(snap.catalog_known).toBe(false);
    expect(snap.models).toEqual([]);
  });
});

describe("fake probe results are cached and served", () => {
  it("a refresh caches the probe results; a SECOND instance on the same file serves them without probing", async () => {
    const h = harness();
    h.statuses["anthropic/claude-b"] = "denied";
    const a = h.make();
    const res = await a.refresh({ provider: "anthropic" });
    expect(res.refreshed).toEqual(["anthropic"]);
    expect(h.calls).toEqual([{ providerID: "anthropic", modelIDs: ["claude-a", "claude-b"] }]);

    const b = h.make();
    const snap = await b.snapshot();
    expect(row(snap, "anthropic", "claude-a")).toMatchObject({ status: "ok", credential_fp: "aaaaaaaaaaaaaaaa", source: "probe" });
    expect(row(snap, "anthropic", "claude-b")).toMatchObject({ status: "denied", reason: "fake reason" });
    expect(row(snap, "openai", "gpt-x")?.status).toBe("unchecked");
    expect(h.calls.length).toBe(1);
    // persisted on disk, keyed by provider → model, with the fp
    const doc = JSON.parse(readFileSync(h.file, "utf8"));
    expect(doc.providers.anthropic.credential_fp).toBe("aaaaaaaaaaaaaaaa");
    expect(doc.providers.anthropic.models["claude-a"].credential_fp).toBe("aaaaaaaaaaaaaaaa");
  });

  it("the GET body serves the snapshot shape", async () => {
    const h = harness();
    const mr = h.make();
    await mr.refresh({ provider: "openai" });
    const body = JSON.parse(await modelReachabilityResponse(mr));
    expect(body.ok).toBe(true);
    expect(body.error).toBeNull();
    expect(body.catalog_known).toBe(true);
    expect(row(body, "openai", "gpt-x")).toMatchObject({ status: "ok", latency_ms: 7, checked_at: h.clock.now });
    const p = body.providers.find((x: { provider: string }) => x.provider === "openai");
    expect(p).toMatchObject({ credential_fp: "aaaaaaaaaaaaaaaa", last_probe_at: h.clock.now, last_error: null });
  });

  it("a provider dropped from the live catalog is not served from the cache", async () => {
    const h = harness();
    const mr = h.make();
    await mr.refresh({ provider: "openai" });
    delete h.catalog.openai;
    const snap = await mr.snapshot();
    expect(row(snap, "openai", "gpt-x")).toBeUndefined();
  });
});

describe("credential_fp change invalidates", () => {
  it("a probe under a NEW fingerprint drops every row cached under the old one (→ unchecked)", async () => {
    const h = harness();
    const mr = h.make({ minProbeIntervalMs: 0 });
    await mr.refresh({ provider: "anthropic" });
    expect(row(await mr.snapshot(), "anthropic", "claude-b")?.status).toBe("ok");

    // The credential rotates; the next probe only reaches claude-a (the
    // catalog shrank to it) — claude-b's old-fp row must NOT stay "ok".
    h.fp.current = "bbbbbbbbbbbbbbbb";
    h.catalog.anthropic = ["claude-a"];
    h.clock.now += 1000;
    await mr.refresh({ provider: "anthropic" });
    h.catalog.anthropic = ["claude-a", "claude-b"];
    const snap = await mr.snapshot();
    expect(row(snap, "anthropic", "claude-a")).toMatchObject({ status: "ok", credential_fp: "bbbbbbbbbbbbbbbb" });
    expect(row(snap, "anthropic", "claude-b")).toMatchObject({ status: "unchecked", credential_fp: null });
  });

  it("an entry whose fp disagrees with the provider's current fp is served as unchecked (hand-edited / partial file)", async () => {
    const h = harness();
    mkdirSync(join(h.file, ".."), { recursive: true });
    writeFileSync(
      h.file,
      JSON.stringify({
        version: 1,
        providers: {
          anthropic: {
            credential_fp: "cccccccccccccccc",
            last_probe_at: h.clock.now,
            last_attempt_at: h.clock.now,
            last_error: null,
            models: {
              "claude-a": { status: "ok", reason: null, latency_ms: 1, checked_at: h.clock.now, credential_fp: "dddddddddddddddd", source: "probe" },
            },
          },
        },
      }),
    );
    const snap = await h.make().snapshot();
    expect(row(snap, "anthropic", "claude-a")?.status).toBe("unchecked");
  });

  it("a disconnected provider (probe says error, fp null) invalidates the old rows", async () => {
    const h = harness();
    const mr = h.make({ minProbeIntervalMs: 0 });
    await mr.refresh({ provider: "openai" });
    h.fp.current = null;
    h.statuses["openai/gpt-x"] = "error";
    await mr.refresh({ provider: "openai" });
    expect(row(await mr.snapshot(), "openai", "gpt-x")).toMatchObject({ status: "error", credential_fp: null });
  });
});

describe("concurrent writers don't corrupt the cache", () => {
  it("two instances on ONE file, interleaving demotes + probe merges, lose no update and leave valid JSON", async () => {
    const h = harness();
    h.catalog = { p1: Array.from({ length: 12 }, (_, i) => `m${i}`), p2: Array.from({ length: 12 }, (_, i) => `n${i}`) };
    const a = h.make();
    const b = h.make();
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      ops.push(a.demote({ provider: "q", model: `a${i}`, status: "denied", reason: `a${i}` }));
      ops.push(b.demote({ provider: "q", model: `b${i}`, status: "unavailable", reason: `b${i}` }));
    }
    ops.push(a.refresh({ provider: "p1" }));
    ops.push(b.refresh({ provider: "p2" }));
    const outs = await Promise.all(ops);
    for (const o of outs) expect((o as { ok: boolean }).ok).toBe(true);

    const doc = JSON.parse(readFileSync(h.file, "utf8"));
    expect(Object.keys(doc.providers.q.models).length).toBe(40);
    expect(Object.keys(doc.providers.p1.models).length).toBe(12);
    expect(Object.keys(doc.providers.p2.models).length).toBe(12);
    expect(existsSync(`${h.file}.lock`)).toBe(false);
  });

  it("a stale lock (dead owner, past the stale window) is reclaimed instead of wedging the cache", async () => {
    const h = harness();
    mkdirSync(`${h.file}.lock`, { recursive: true });
    writeFileSync(join(`${h.file}.lock`, "owner"), JSON.stringify({ pid: 999999, ts: Date.now() - 60_000 }));
    const res = await h.make({ staleLockMs: 1000 }).demote({ provider: "openai", model: "gpt-x", status: "denied", reason: null });
    expect(res.ok).toBe(true);
    expect(existsSync(`${h.file}.lock`)).toBe(false);
  });
});

describe("refresh is rate-limited", () => {
  it("a second refresh inside the floor is refused with retry_after_ms and does NOT probe — across instances too", async () => {
    const h = harness();
    const a = h.make({ minProbeIntervalMs: 60_000 });
    const first = await a.refresh({ provider: "anthropic" });
    expect(first.refreshed).toEqual(["anthropic"]);

    h.clock.now += 10_000;
    const again = await a.refresh({ provider: "anthropic" });
    expect(again.refreshed).toEqual([]);
    expect(again.rate_limited).toEqual([{ provider: "anthropic", retry_after_ms: 50_000 }]);

    const other = await h.make({ minProbeIntervalMs: 60_000 }).refresh({ provider: "anthropic" });
    expect(other.rate_limited.map((r) => r.provider)).toEqual(["anthropic"]);
    expect(h.calls.length).toBe(1);

    h.clock.now += 50_000;
    const later = await a.refresh({ provider: "anthropic" });
    expect(later.refreshed).toEqual(["anthropic"]);
    expect(h.calls.length).toBe(2);
  });

  it("concurrent refreshes from two instances probe once (the claim is taken under the lock)", async () => {
    const h = harness();
    const [r1, r2] = await Promise.all([h.make().refresh({ provider: "openai" }), h.make().refresh({ provider: "openai" })]);
    expect(h.calls.length).toBe(1);
    expect([...r1.refreshed, ...r2.refreshed]).toEqual(["openai"]);
  });

  it("a failed probe still counts against the floor (no hammering a dead engine) and records last_error", async () => {
    const h = harness();
    let n = 0;
    const mr = h.make({
      probe: async () => {
        n++;
        throw new Error("engine down");
      },
    });
    const res = await mr.refresh({ provider: "openai" });
    expect(res.failed).toEqual([{ provider: "openai", error: "probe_failed" }]);
    const again = await mr.refresh({ provider: "openai" });
    expect(again.rate_limited.length).toBe(1);
    expect(n).toBe(1);
    const snap = await mr.snapshot();
    expect(snap.providers.find((p) => p.provider === "openai")?.last_error).toBe("probe_failed");
    expect(row(snap, "openai", "gpt-x")?.status).toBe("unchecked");
  });

  it("the scheduler tick probes on connect (never probed) and daily — not on every tick", async () => {
    const h = harness();
    const mr = h.make({ minProbeIntervalMs: 60_000, dailyIntervalMs: 86_400_000 });
    await mr.tick();
    expect(h.calls.map((c) => c.providerID).sort()).toEqual(["anthropic", "openai"]);
    h.clock.now += 3_600_000;
    await mr.tick();
    expect(h.calls.length).toBe(2);
    // a provider connects later → probed on the next tick (on-connect)
    h.catalog.google = ["gemini"];
    await mr.tick();
    expect(h.calls.map((c) => c.providerID)).toEqual(expect.arrayContaining(["google"]));
    expect(h.calls.length).toBe(3);
    h.clock.now += 86_400_000;
    await mr.tick();
    expect(h.calls.length).toBe(6);
  });

  it("the refresh route body: bad provider → bad_request; unknown catalog → engine_unavailable", async () => {
    const h = harness();
    const bad = JSON.parse(await refreshModelReachabilityResponse({ provider: 42 }, h.make()));
    expect(bad).toMatchObject({ ok: false });
    expect(bad.error).toMatch(/^bad_request: /);
    const unknown = JSON.parse(await refreshModelReachabilityResponse("{}", h.make({ listModels: async () => undefined })));
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatch(/^engine_unavailable: /);
    const notConnected = JSON.parse(await refreshModelReachabilityResponse({ provider: "nope" }, h.make()));
    expect(notConnected.error).toMatch(/^bad_request: /);
    const ok = JSON.parse(await refreshModelReachabilityResponse({}, h.make()));
    expect(ok.ok).toBe(true);
    expect(ok.refreshed.sort()).toEqual(["anthropic", "openai"]);
  });
});

describe("demote sticks until the next probe", () => {
  it("a demotion overrides a cached ok across instances and ticks, and the next probe replaces it", async () => {
    const h = harness();
    const a = h.make({ minProbeIntervalMs: 60_000 });
    await a.refresh({ provider: "anthropic" });
    const d = JSON.parse(
      await demoteModelReachabilityResponse(
        { provider: "anthropic", model: "claude-a", status: "rate-limited", reason: "429 in dispatch" },
        a,
      ),
    );
    expect(d).toMatchObject({ ok: true, provider: "anthropic", model: "claude-a", status: "rate-limited", error: null });

    const b = h.make({ minProbeIntervalMs: 60_000 });
    expect(row(await b.snapshot(), "anthropic", "claude-a")).toMatchObject({
      status: "rate-limited",
      reason: "429 in dispatch",
      source: "demoted",
      credential_fp: "aaaaaaaaaaaaaaaa",
    });
    await b.tick(); // not due — the demotion stands
    expect(row(await b.snapshot(), "anthropic", "claude-a")?.status).toBe("rate-limited");

    h.clock.now += 60_000;
    await b.refresh({ provider: "anthropic" });
    expect(row(await a.snapshot(), "anthropic", "claude-a")).toMatchObject({ status: "ok", source: "probe" });
  });

  it("the demote body is validated (no ok demotion, no unknown status, strings only) and never echoed", async () => {
    const h = harness();
    const mr = h.make();
    for (const body of [
      { provider: "anthropic", model: "claude-a", status: "ok" },
      { provider: "anthropic", model: "claude-a", status: "unchecked" },
      { provider: "anthropic", model: "claude-a", status: "<script>" },
      { provider: "", model: "claude-a", status: "denied" },
      { provider: "anthropic", status: "denied" },
      { provider: "anthropic", model: "claude-a", status: "denied", reason: 5 },
      "not json",
    ]) {
      const res = JSON.parse(await demoteModelReachabilityResponse(body, mr));
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/^bad_request: /);
      expect(res.error).not.toContain("<script>");
    }
  });

  it("a demotion of a never-probed model is served as demoted (not ok, not lost)", async () => {
    const h = harness();
    const mr = h.make();
    await mr.demote({ provider: "openai", model: "gpt-x", status: "denied", reason: null });
    expect(row(await mr.snapshot(), "openai", "gpt-x")).toMatchObject({ status: "denied", source: "demoted" });
  });
});

describe("the engine client (llm_creds) — key-free catalog + probe", () => {
  it("fetchProviderModels returns only provider ids → model ids (no key material)", async () => {
    const fetchImpl = (async (url: string) => {
      expect(String(url)).toBe("http://e/config/providers");
      return new Response(
        JSON.stringify({
          providers: [
            { id: "anthropic", key: "sk-SECRET", models: { "claude-a": { id: "claude-a" }, "claude-b": {} } },
            { id: "openai", options: { apiKey: "sk-SECRET2" }, models: {} },
          ],
          default: {},
        }),
      );
    }) as unknown as typeof fetch;
    const out = await fetchProviderModels("http://e/", { fetchImpl });
    expect(out).toEqual({ anthropic: ["claude-a", "claude-b"], openai: [] });
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });

  it("fetchProviderModels → undefined on failure (unknown, never empty)", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await fetchProviderModels("http://e", { fetchImpl })).toBeUndefined();
  });

  it("probeProviderModels POSTs {providerID, modelIDs} to /provider/probe and returns the parsed body", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url: String(url), init };
      return new Response(
        JSON.stringify({
          providerID: "openai",
          results: [{ model: "gpt-x", status: "ok", latency_ms: 3, reason: null, credential_fp: "aaaaaaaaaaaaaaaa", checked_at: 1 }],
        }),
      );
    }) as unknown as typeof fetch;
    const out = await probeProviderModels("http://e", "openai", ["gpt-x"], { fetchImpl, headers: { Authorization: "Basic x" } });
    expect(seen?.url).toBe("http://e/provider/probe");
    expect(seen?.init.method).toBe("POST");
    expect(JSON.parse(String(seen?.init.body))).toEqual({ providerID: "openai", modelIDs: ["gpt-x"] });
    expect((seen?.init.headers as Record<string, string>).Authorization).toBe("Basic x");
    expect(out?.results[0]?.status).toBe("ok");
  });
});

describe("the route family registers on the live service (boot proof)", () => {
  const prevOps = process.env.AMICODE_OPS_DIR;
  beforeEach(() => {
    process.env.AMICODE_OPS_DIR = mkdtempSync(join(tmpdir(), "amc-1985-ops-"));
  });
  afterEach(() => {
    if (prevOps === undefined) delete process.env.AMICODE_OPS_DIR;
    else process.env.AMICODE_OPS_DIR = prevOps;
  });

  it("the default cache file lives under AMICODE_OPS_DIR", () => {
    expect(reachabilityCacheFile()).toBe(join(process.env.AMICODE_OPS_DIR as string, "model-reachability.json"));
  });

  it("GET + refresh + demote answer on a booted createAmicodeService", async () => {
    const { createAmicodeService } = await import("../src/amicode_service");
    const h = harness(reachabilityCacheFile());
    const service = createAmicodeService({
      modelReachability: {
        listModels: async () => structuredClone(h.catalog),
        probe: async (providerID, modelIDs) => ({
          providerID,
          results: modelIDs.map((model) => ({ model, status: "ok" as const, latency_ms: 1, reason: null, credential_fp: "aaaaaaaaaaaaaaaa", checked_at: 1 })),
        }),
        schedulerIntervalMs: 0,
      },
    });
    const url = await service.start();
    const auth = service.authHeader;
    const post = (path: string, body: unknown) =>
      fetch(new URL(path, url), { method: "POST", headers: { Authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      const get = await fetch(new URL("/amicode/model-reachability", url), { headers: { Authorization: auth } });
      expect(get.status).toBe(200);
      const body = JSON.parse(await get.text());
      expect(body.ok).toBe(true);
      expect(row(body, "openai", "gpt-x")?.status).toBe("unchecked");

      const refresh = JSON.parse(await (await post("/amicode/model-reachability/refresh", { provider: "openai" })).text());
      expect(refresh).toMatchObject({ ok: true, refreshed: ["openai"] });
      const demote = JSON.parse(
        await (await post("/amicode/model-reachability/demote", { provider: "openai", model: "gpt-x", status: "denied", reason: "403" })).text(),
      );
      expect(demote.ok).toBe(true);
      const after = JSON.parse(await (await fetch(new URL("/amicode/model-reachability", url), { headers: { Authorization: auth } })).text());
      expect(row(after, "openai", "gpt-x")).toMatchObject({ status: "denied", source: "demoted" });
    } finally {
      await service.stop();
    }
  });

  it("the route family registers even with no engine deps (GET serves the cache, refresh is engine_unavailable)", async () => {
    const { createAmicodeService } = await import("../src/amicode_service");
    const service = createAmicodeService({});
    const url = await service.start();
    try {
      const get = await fetch(new URL("/amicode/model-reachability", url), { headers: { Authorization: service.authHeader } });
      expect(get.status).toBe(200);
      expect(JSON.parse(await get.text())).toMatchObject({ ok: true, catalog_known: false, models: [] });
    } finally {
      await service.stop();
    }
  });
});

describe("the headless hub runner wires the route family (fake engine)", () => {
  const boots: AmicodeServiceRunnerBoot[] = [];
  const prevOps = process.env.AMICODE_OPS_DIR;
  afterAll(async () => {
    for (const b of boots.splice(0)) await b.shutdown().catch(() => undefined);
    if (prevOps === undefined) delete process.env.AMICODE_OPS_DIR;
    else process.env.AMICODE_OPS_DIR = prevOps;
  });

  /** A stand-in engine: health 200, a key-bearing /config/providers (the
   *  client must strip it), and a /provider/probe answering ok per model. */
  function writeFakeEngine(dir: string): string {
    const bin = join(dir, "fake-engine");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const { createServer } = require("node:http");
const port = Number(process.argv[4] ?? 0);
createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/config/providers") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ providers: [{ id: "fakeprov", key: "sk-SECRET", models: { "fm-1": {}, "fm-2": {} } }], default: {} }));
    }
    if (u.pathname === "/provider/probe" && req.method === "POST") {
      const body = JSON.parse(raw);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ providerID: body.providerID, results: body.modelIDs.map((m) => ({ model: m, status: "ok", latency_ms: 2, reason: null, credential_fp: "eeeeeeeeeeeeeeee", checked_at: 1 })) }));
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("fake engine up");
  });
}).listen(port, "127.0.0.1");
`,
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  it("GET /amicode/model-reachability answers on the runner's service and refresh probes THROUGH the runner's engine", async () => {
    process.env.AMICODE_OPS_DIR = mkdtempSync(join(tmpdir(), "amc-1985-runner-ops-"));
    const dir = mkdtempSync(join(tmpdir(), "amc-1985-runner-"));
    const shelf = mkdtempSync(join(tmpdir(), "amc-1985-runner-shelf-"));
    writeFileSync(join(shelf, "index.html"), "<!doctype html><title>stub</title>");
    const boot = await bootAmicodeServiceRunner({
      engineBin: writeFakeEngine(dir),
      appDistRoot: shelf,
      healthTimeoutMs: 10_000,
      servicePort: 0,
      enginePort: 0,
      log: () => undefined,
    });
    boots.push(boot);
    const auth = { Authorization: boot.authHeader };

    const get = await fetch(`${boot.url}/amicode/model-reachability`, { headers: auth });
    expect(get.status).toBe(200);
    const body = JSON.parse(await get.text());
    expect(body.ok).toBe(true);
    expect(body.catalog_known).toBe(true);
    expect(JSON.stringify(body)).not.toContain("SECRET");

    const refresh = await fetch(`${boot.url}/amicode/model-reachability/refresh`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ provider: "fakeprov" }),
    });
    const r = JSON.parse(await refresh.text());
    // the boot tick may have claimed the probe first; either way the cache
    // ends up served from the runner's engine
    expect(r.ok).toBe(true);
    let after: { models: Array<{ provider: string; model: string }> } = { models: [] };
    for (let i = 0; i < 50; i++) {
      after = JSON.parse(await (await fetch(`${boot.url}/amicode/model-reachability`, { headers: auth })).text());
      if (row(after, "fakeprov", "fm-1")?.status === "ok") break;
      await new Promise((res) => setTimeout(res, 100));
    }
    expect(row(after, "fakeprov", "fm-1")).toMatchObject({ status: "ok", credential_fp: "eeeeeeeeeeeeeeee" });
  }, 30_000);
});
