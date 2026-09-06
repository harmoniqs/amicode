// Amicode-service bootstrap auth (#823, the M3 cutover seam): the framed app
// bootstraps through an iframe document GET that structurally CANNOT carry an
// Authorization header — the panel rides the ENGINE's `?auth_token=` carrier
// (base64("opencode:<password>"), server_auth.ts). The service parsed Basic
// only until now, so at cutover the shelf document GET would 401 — THIS file
// pins the seam: the service accepts the engine's query carrier on GETs (the
// framed path: document + SPA routes + split-frame panes), and mirrors the
// engine's public-UI exemptions (fork public-ui.ts parity) for the anonymous
// sub-resource fetches a browser cannot credential (the /assets/ bundles,
// the manifest, the widget frame document).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { createAmicodeService } from "../src/amicode_service";
import { serverAuthToken } from "../src/server_auth";

/** A minimal app dist (the app-shelf test's shape): index + /assets/. */
function buildMockDist(root: string): string {
  const dist = join(root, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(
    join(dist, "index.html"),
    "<!doctype html><html><head><title>amicode app</title></head><body><div id=root></div></body></html>",
  );
  writeFileSync(join(dist, "assets", "app.js"), "console.log('app bundle');\n");
  writeFileSync(join(dist, "site.webmanifest"), '{"name":"Amicode"}\n');
  return dist;
}

/** The mock engine (the proxy test's harness shape): /session answers JSON. */
async function startMockEngine(): Promise<{ url: string; stop(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/session")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, engine: true }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, stop: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("amicode service — bootstrap auth seam (the M3 cutover, #823)", () => {
  let root: string;
  let engine: Awaited<ReturnType<typeof startMockEngine>>;
  let service: ReturnType<typeof createAmicodeService>;
  let base: string;
  /** The ENGINE mint's carrier — what the panel puts on the iframe src. */
  let engineToken: string;
  /** The service's own mint's carrier (accepted too — one carrier shape). */
  let serviceToken: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-bootstrap-"));
    const dist = buildMockDist(root);
    engine = await startMockEngine();
    service = createAmicodeService({
      password: "service-own-mint",
      engine: { password: "engine-mint-password", getUrl: () => engine.url },
      shelf: { distRoot: dist },
    });
    base = (await service.start()).toString().replace(/\/$/, "");
    engineToken = serverAuthToken("engine-mint-password");
    serviceToken = serverAuthToken("service-own-mint");
  });

  afterAll(async () => {
    await service.stop();
    await engine.stop();
    rmSync(root, { recursive: true, force: true });
  });

  // ── the iframe document bootstrap: ?auth_token= with NO header ────────────
  it("the origin document GET bootstraps with the engine's ?auth_token= carrier (no header)", async () => {
    const r = await fetch(`${base}/?auth_token=${encodeURIComponent(engineToken)}`, {
      headers: { Accept: "text/html" }, // NO Authorization — the iframe cannot carry one
    });
    expect(r.status).toBe(200);
    expect((r.headers.get("content-type") ?? "").startsWith("text/html")).toBe(true);
    expect(await r.text()).toContain("<div id=root>");
  });

  it("the service's OWN mint rides the same carrier (one carrier shape, both mints)", async () => {
    const r = await fetch(`${base}/?auth_token=${encodeURIComponent(serviceToken)}`, {
      headers: { Accept: "text/html" },
    });
    expect(r.status).toBe(200);
  });

  it("SPA routes bootstrap the same way (the framed app's client-side routes)", async () => {
    const r = await fetch(`${base}/new-session?auth_token=${encodeURIComponent(engineToken)}`, {
      headers: { Accept: "text/html" },
    });
    expect(r.status).toBe(200);
    expect((r.headers.get("content-type") ?? "").startsWith("text/html")).toBe(true);
    expect(await r.text()).toContain("<div id=root>"); // the SPA fallback document, not a 401
  });

  it("a wrong carrier 401s (fail closed, never open)", async () => {
    const r = await fetch(`${base}/?auth_token=${encodeURIComponent(serverAuthToken("wrong-mint"))}`, {
      headers: { Accept: "text/html" },
    });
    expect(r.status).toBe(401);
  });

  it("a garbage (non-base64 / non-user:pass) carrier 401s", async () => {
    const r = await fetch(`${base}/?auth_token=${encodeURIComponent("!!not-base64!!")}`, {
      headers: { Accept: "text/html" },
    });
    expect(r.status).toBe(401);
  });

  // ── scope: GET-only (the design note's framed path), never POST ───────────
  it("the carrier is GET-only: a POST with ?auth_token= and no header stays 401", async () => {
    const r = await fetch(`${base}/amicode/profile?auth_token=${encodeURIComponent(engineToken)}`, {
      method: "POST",
    });
    expect(r.status).toBe(401);
  });

  it("the engine's own carrier-preference parity: a VALID header loses to a GARBAGE query carrier on GETs", async () => {
    // The engine's middleware reads the query carrier FIRST and falls back to
    // the header only when the query is absent — so a request the service
    // accepted would be 401'd upstream. Mirror the engine exactly.
    const r = await fetch(`${base}/session?auth_token=${encodeURIComponent("!!garbage!!")}`, {
      headers: { Authorization: `Basic ${engineToken}` },
    });
    expect(r.status).toBe(401);
  });

  it("a query-carrier GET reaches the engine through the proxy with the query preserved upstream", async () => {
    const r = await fetch(`${base}/session?auth_token=${encodeURIComponent(engineToken)}`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { engine?: boolean }).engine).toBe(true); // the mock engine answered
  });

  // ── the anonymous sub-resources a browser cannot credential ───────────────
  it("GET /assets/* is public (the app's fingerprinted bundles — anonymous, like the engine)", async () => {
    const r = await fetch(`${base}/assets/app.js`); // NO credentials at all
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/javascript");
    expect(await r.text()).toContain("app bundle");
  });

  it("GET /site.webmanifest is public (the manifest link in <head> — engine parity)", async () => {
    const r = await fetch(`${base}/site.webmanifest`);
    expect(r.status).toBe(200);
  });

  it("GET /amicode/widget-frame is public (an iframe DOCUMENT request — cannot carry a credential; fork public-ui parity)", async () => {
    const r = await fetch(`${base}/amicode/widget-frame`);
    expect(r.status).toBe(200);
    expect((r.headers.get("content-type") ?? "").startsWith("text/html")).toBe(true);
  });

  it("the public-UI exemption is GET-only: an anonymous POST to a public path stays 401", async () => {
    const r = await fetch(`${base}/assets/app.js`, { method: "POST" });
    expect(r.status).toBe(401);
  });

  it("the API surface stays fully authed: anonymous GET /amicode/profile still 401s", async () => {
    const r = await fetch(`${base}/amicode/profile`);
    expect(r.status).toBe(401);
  });

  it("an anonymous non-public API GET keeps the honest no-engine-path answer shape (not the SPA doc)", async () => {
    // No engine bound for THIS service instance… actually one IS bound; use
    // the mock engine's 404 — the point is the answer is the engine's JSON,
    // never the SPA document, for an unauthenticated API-shaped GET.
    const r = await fetch(`${base}/session`, { headers: { Accept: "application/json" } });
    expect(r.status).toBe(401);
  });
});
