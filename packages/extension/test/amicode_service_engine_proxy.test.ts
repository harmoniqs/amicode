// Amicode-service engine proxy (#822) — the fork-cutover proxy slice: every
// non-amicode, non-static request streams through to the spawned engine
// (method/headers/body passthrough, SSE unbuffered), while exact /amicode/*
// routes and static shelf hits never reach it (the precedence contract), and
// auth accepts the engine token everywhere (the framed app bootstraps with the
// engine credential — zero app-side change). Mock upstream: a node:http
// engine that records what it receives, per the issue's Testing Decisions.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { createAmicodeService } from "../src/amicode_service";
import { serverAuthHeader } from "../src/server_auth";
import { EngineProxy } from "../src/amicode_service/engine_proxy";
import { HubProxy } from "../src/amicode_service/hub_proxy";
import type { HubCredentialRead } from "../src/amicode_service/hub_credential";
import { fakeEngine, startEngineSseServer, LOCAL_EPOCH } from "./fixtures/engine_stream/engine_frames";

interface RecordedHit {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** The mock engine: records every request it receives; /session answers JSON,
 *  /echo echoes the body + content-type, /event is an SSE stream with spaced
 *  chunks (the unbuffered-passthrough probe). */
async function startMockEngine(): Promise<{ hits: RecordedHit[]; url: string; stop(): Promise<void> }> {
  const hits: RecordedHit[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      hits.push({ method: req.method ?? "GET", url: req.url ?? "/", headers: { ...req.headers }, body });
      if (req.method === "GET" && req.url === "/session") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, engine: true, sessions: [] }));
        return;
      }
      if (req.method === "POST" && req.url === "/echo") {
        res.writeHead(200, { "content-type": String(req.headers["content-type"] ?? "text/plain") });
        res.end(body);
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/event")) {
        // SSE with deliberate spacing: a BUFFERING proxy would deliver all
        // chunks at once when the response ends; an unbuffered one delivers
        // them as the engine sends them.
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: chunk-1\n\n");
        setTimeout(() => res.write("data: chunk-2\n\n"), 120);
        setTimeout(() => res.end("data: chunk-3\n\n"), 240);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "not found", mockEngine: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    hits,
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("amicode service — engine proxy (transparent passthrough to the spawned engine)", () => {
  let root: string;
  let engine: Awaited<ReturnType<typeof startMockEngine>>;
  let service: ReturnType<typeof createAmicodeService>;
  let base: string;
  const enginePassword = "engine-mint-test-password";
  let engineAuth: string;
  let savedAuthEnv: string | undefined;

  beforeAll(async () => {
    // The boot relies on the credential auth default; a dev host running a
    // live amicode service exports AMICODE_SERVICE_AUTH=open (the runner's
    // tunnel/LAN posture) which would fail the 401 pin here. Isolate it.
    savedAuthEnv = process.env.AMICODE_SERVICE_AUTH;
    delete process.env.AMICODE_SERVICE_AUTH;
    root = mkdtempSync(join(tmpdir(), "amicode-proxy-"));
    const dist = join(root, "dist");
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><html><body><div id=root>app</div></body></html>");
    writeFileSync(join(dist, "assets", "app.js"), "console.log('app');\n");

    engine = await startMockEngine();
    service = createAmicodeService({
      password: "service-own-mint",
      engine: { password: enginePassword, getUrl: () => engine.url },
      shelf: { distRoot: dist },
    });
    base = (await service.start()).toString().replace(/\/$/, "");
    engineAuth = serverAuthHeader(enginePassword);
  });

  afterAll(async () => {
    await service.stop();
    await engine.stop();
    rmSync(root, { recursive: true, force: true });
    if (savedAuthEnv !== undefined) process.env.AMICODE_SERVICE_AUTH = savedAuthEnv;
  });

  it("a non-amicode, non-static request proxies to the engine: method, path, headers, body preserved", async () => {
    const r = await fetch(base + "/session", { headers: { Authorization: engineAuth } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    const body = (await r.json()) as { engine?: boolean };
    expect(body.engine).toBe(true); // the MOCK engine answered — the request really went upstream
    const hit = engine.hits.find((h) => h.url === "/session");
    expect(hit, "the engine must have received the request").toBeDefined();
    expect(hit!.method).toBe("GET");
    // Transparent: the client's Authorization rides unchanged — no rewriting.
    expect(hit!.headers.authorization).toBe(engineAuth);
  });

  it("POST bodies and content-types ride through unchanged", async () => {
    const payload = JSON.stringify({ parts: [{ type: "text", text: "hello" }] });
    const r = await fetch(base + "/echo", {
      method: "POST",
      headers: { Authorization: engineAuth, "Content-Type": "application/json", "X-Custom-Probe": "carried" },
      body: payload,
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(await r.text()).toBe(payload);
    const hit = engine.hits.find((h) => h.url === "/echo");
    expect(hit!.method).toBe("POST");
    expect(hit!.body).toBe(payload);
    expect(hit!.headers["content-type"]).toBe("application/json");
    expect(hit!.headers["x-custom-probe"]).toBe("carried");
  });

  it("the ENGINE token is accepted on an /amicode/* route (accept-both auth); an unknown token is still 401", async () => {
    // The framed app bootstraps with the engine credential — the service's
    // own /amicode/* route table must take it, not just the proxied paths.
    const r = await fetch(base + "/amicode/profile", { headers: { Authorization: engineAuth } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
    // The service's own mint keeps working everywhere (nothing was replaced).
    const ownAuth = serverAuthHeader("service-own-mint");
    const own = await fetch(base + "/amicode/profile", { headers: { Authorization: ownAuth } });
    expect(own.status).toBe(200);
    // A token that is NEITHER mint is rejected — accept-both is not accept-all.
    const unknown = serverAuthHeader("not-any-mint");
    const bad = await fetch(base + "/amicode/profile", { headers: { Authorization: unknown } });
    expect(bad.status).toBe(401);
  });

  it("precedence: an exact /amicode/* route never reaches the proxy, and a static shelf hit never reaches the proxy", async () => {
    // /amicode/* is the service's OWN namespace — the mock engine must never
    // see it (a proxied /amicode/* would launder our route table upstream).
    const route = await fetch(base + "/amicode/profile", { headers: { Authorization: engineAuth } });
    expect(route.status).toBe(200);
    expect(engine.hits.some((h) => h.url.startsWith("/amicode")), "no /amicode/* hit may reach the engine").toBe(false);
    // A static asset is served by the shelf — the engine never sees it.
    const asset = await fetch(base + "/assets/app.js", { headers: { Authorization: engineAuth } });
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    expect(await asset.text()).toContain("console.log");
    expect(engine.hits.some((h) => h.url.startsWith("/assets")), "no /assets hit may reach the engine").toBe(false);
  });

  it("SSE (/event) streams UNBUFFERED through the proxy (chunks arrive as the engine sends them)", async () => {
    const r = await fetch(base + "/event", { headers: { Authorization: engineAuth } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const chunks: Array<{ text: string; at: number }> = [];
    const started = Date.now();
    if (!r.body) throw new Error("no response body stream");
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push({ text: Buffer.from(value).toString(), at: Date.now() - started });
    }
    const joined = chunks.map((c) => c.text).join("");
    expect(joined).toContain("chunk-1");
    expect(joined).toContain("chunk-3");
    // The engine spaces its chunks 120ms apart; a buffering proxy would flush
    // everything at response end (all arrival times within a few ms). Allow a
    // generous margin against scheduling noise — the property under test is
    // "progressive", not "low latency".
    const first = chunks[0]!.at;
    const last = chunks[chunks.length - 1]!.at;
    expect(last - first, `first@${first}ms last@${last}ms — buffered, not streamed`).toBeGreaterThanOrEqual(180);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// #1773 AC3 — a proxied stream lost AFTER its response headers were sent is an
// ERROR close, never a clean end. The proxies used to answer an upstream failure
// mid-stream with `res.end()`, which a listener (or the next relay) reads as
// "the stream ended normally, nothing was lost". Both the engine proxy and the
// hub proxy now destroy the downstream with the error, so it sees a transport
// error. A clean upstream end still passes through as a clean end.
// ══════════════════════════════════════════════════════════════════════════════
describe("#1773 AC3 — engine and hub proxies error-close a stream lost after headers", () => {
  /** Serve `handler` on 127.0.0.1:0 and dial it at its own address. */
  async function front(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
    const server = http.createServer(handler);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      stop: () =>
        new Promise<void>((r) => {
          server.close(() => r());
          server.closeAllConnections?.();
        }),
    };
  }

  /** Read a whole response: its status, body, and whether it ENDED cleanly or ERRORED. */
  function read(url: string): Promise<{ status: number; body: string; how: "end" | "error" }> {
    return new Promise((resolve, reject) => {
      const req = http.get(url, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, how: "end" }));
        res.on("error", () => resolve({ status: res.statusCode ?? 0, body, how: "error" }));
      });
      req.on("error", reject);
    });
  }

  const hubCredential = (): HubCredentialRead => ({
    ok: true,
    mint: "hub",
    credential: { baseUrl: "http://hub.invalid", token: "hub-tok" },
  });

  const proxies: Array<{ name: string; handler: (upstreamUrl: string) => (req: http.IncomingMessage, res: http.ServerResponse) => void }> = [
    {
      name: "engine proxy",
      handler: (upstreamUrl) => {
        const proxy = new EngineProxy({ getUrl: () => upstreamUrl });
        return (req, res) => void proxy.handle(req, res);
      },
    },
    {
      name: "hub proxy",
      handler: (upstreamUrl) => {
        const proxy = new HubProxy({ getUrl: () => upstreamUrl, credential: hubCredential });
        return (req, res) => void proxy.handle(req, res);
      },
    },
  ];

  for (const { name, handler } of proxies) {
    it(`${name}: the upstream dies mid-stream → the listener's response ERRORS after the frames it got (no clean end)`, async () => {
      const engine = fakeEngine({ legacy: true });
      const sent = [engine.connected(), engine.event("session.status", { sessionID: "ses_1", status: { type: "busy" } })];
      const upstream = await startEngineSseServer((res) => {
        for (const f of sent) res.write(f);
        setTimeout(() => res.destroy(), 20); // the link dies after the headers and two frames
      });
      const relay = await front(handler(upstream.url));
      try {
        const { status, body, how } = await read(`${relay.url}/global/event`);
        expect(status).toBe(200); // the headers were already relayed …
        expect(body).toBe(sent.join("")); // … with every frame the upstream sent …
        expect(how).toBe("error"); // … so the loss must surface as a transport error
      } finally {
        await relay.stop();
        await upstream.stop();
      }
    });

    it(`${name}: a clean upstream end still relays as a clean end (pass-through unchanged)`, async () => {
      const engine = fakeEngine({ epoch: LOCAL_EPOCH });
      const sent = [engine.connected(), engine.heartbeat()];
      const upstream = await startEngineSseServer((res) => {
        for (const f of sent) res.write(f);
        res.end();
      });
      const relay = await front(handler(upstream.url));
      try {
        expect(await read(`${relay.url}/global/event`)).toEqual({ status: 200, body: sent.join(""), how: "end" });
      } finally {
        await relay.stop();
        await upstream.stop();
      }
    });
  }
});
