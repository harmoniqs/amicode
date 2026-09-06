// Amicode-service app shelf (#822) — the fork-cutover static slice: the
// extension-host service serves the built app-bundle dist (SPA fallback,
// content types, traversal refusal, honest needs-setup placeholder when no
// dist exists) ahead of the engine proxy, with exact /amicode/* routes always
// winning (the precedence contract). All tests use mock dists in tmp dirs —
// the heavy real build is the env-gated probe's business, not the unit suite's.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import * as http from "node:http";
import { createAmicodeService } from "../src/amicode_service";

/** Raw-path GET (fetch normalizes dot segments; the server must also survive
 *  clients that don't). Returns {status, body}. */
function rawGet(origin: string, rawPath: string, auth: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(origin);
    const req = http.request(
      { host: u.hostname, port: u.port, path: rawPath, headers: { Authorization: auth, Accept: "text/html" } },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** A minimal app dist: an index document + the asset kinds a vite build emits. */
function buildMockDist(root: string): string {
  const dist = join(root, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(
    join(dist, "index.html"),
    "<!doctype html><html><head><title>amicode app</title></head><body><div id=root></div></body></html>",
  );
  writeFileSync(join(dist, "assets", "app.js"), "console.log('app bundle');\n");
  writeFileSync(join(dist, "assets", "app.css"), "body { color: rebeccapurple; }\n");
  writeFileSync(join(dist, "assets", "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>\n");
  writeFileSync(join(dist, "favicon.ico"), "\x00\x00\x01\x00");
  return dist;
}

describe("amicode service — app shelf (static serving of the app dist)", () => {
  let root: string;
  let dist: string;
  let service: ReturnType<typeof createAmicodeService>;
  let base: string;
  let auth: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-shelf-"));
    dist = buildMockDist(root);
    service = createAmicodeService({ password: "shelf-test-password", shelf: { distRoot: dist } });
    const url = await service.start();
    base = url.toString().replace(/\/$/, "");
    auth = service.authHeader;
  });

  afterAll(async () => {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("GET / serves the app dist's index document (the origin document, text/html)", async () => {
    const r = await fetch(base + "/", { headers: { Authorization: auth, Accept: "text/html" } });
    expect(r.status).toBe(200);
    expect((r.headers.get("content-type") ?? "").startsWith("text/html")).toBe(true);
    const body = await r.text();
    expect(body).toContain("<div id=root>");
  });

  it("asset requests get correct content types (never text/html for an asset)", async () => {
    const cases: Array<[string, string, string]> = [
      ["/assets/app.js", "text/javascript", "app bundle"],
      ["/assets/app.css", "text/css", "rebeccapurple"],
      ["/assets/logo.svg", "image/svg+xml", "<svg"],
    ];
    for (const [path, type, snippet] of cases) {
      const r = await fetch(base + path, { headers: { Authorization: auth } });
      expect(r.status, `${path} status`).toBe(200);
      expect(r.headers.get("content-type"), `${path} content-type`).toContain(type);
      const body = await r.text();
      expect(body, `${path} body`).toContain(snippet);
    }
  });

  it("unmatched GETs that accept HTML fall back to the SPA index; API-style GETs do not", async () => {
    const doc = await fetch(base + "/runs/some-client-route", {
      headers: { Authorization: auth, Accept: "text/html" },
    });
    expect(doc.status).toBe(200);
    expect((doc.headers.get("content-type") ?? "").startsWith("text/html")).toBe(true);
    expect(await doc.text()).toContain("<div id=root>");
    // The API surface keeps honest non-HTML answers: a JSON GET that is no
    // static file falls through toward the engine (no engine attached here →
    // the honest 503), never the SPA document.
    const api = await fetch(base + "/session/xyz", {
      headers: { Authorization: auth, Accept: "application/json" },
    });
    expect(api.status).toBe(503);
    expect(api.headers.get("content-type")).toContain("application/json");
  });

  it("path traversal is refused (403, never a file outside the root)", async () => {
    const root = mkdtempSync(join(tmpdir(), "amicode-shelf-outside-"));
    writeFileSync(join(root, "secret.txt"), "the shelf must never serve this\n");
    const outside = basename(root);
    // NOTE on what counts as a traversal request: the WHATWG URL parser
    // (both fetch client-side AND the server's new URL()) collapses pure dot
    // segments — literal `../` and exact `%2e%2e` — before the shelf ever
    // sees them. The carriers that DO reach the shelf decode to paths that
    // escape the dist root; those must be refused 403, and no response may
    // ever leak the outside file. Raw http.request because fetch normalizes
    // its inputs the same way the server does.
    const evildoers = [
      `/..%2f${encodeURIComponent(outside)}%2fsecret.txt`,
      `/..%2F${encodeURIComponent(outside)}%2Fsecret.txt`,
      "/a/..%2f..%2f/secret.txt",
      "/..%2f..%2fetc%2fpasswd",
    ];
    for (const evil of evildoers) {
      const r = await rawGet(base, evil, auth);
      expect(r.status, `${evil} must be refused`).toBe(403);
      expect(r.body).not.toContain("the shelf must never serve this");
    }
    // The pure-dot forms are normalized away before the shelf (they 403/SPA
    // as ordinary paths) — but they still must never leak the file either.
    for (const normalized of [`/../${outside}/secret.txt`, "/%2e%2e/%2e%2e/etc/passwd"]) {
      const r = await rawGet(base, normalized, auth);
      expect(r.body).not.toContain("the shelf must never serve this");
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("with no dist present, document GETs get the honest needs-setup placeholder (never a silent 404)", async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "amicode-shelf-empty-"));
    const bare = createAmicodeService({ password: "shelf-empty-password", shelf: { distRoot: emptyRoot } });
    const bareBase = (await bare.start()).toString().replace(/\/$/, "");
    try {
      const r = await fetch(bareBase + "/", { headers: { Authorization: bare.authHeader, Accept: "text/html" } });
      expect(r.status).toBe(200);
      expect((r.headers.get("content-type") ?? "").startsWith("text/html")).toBe(true);
      const body = await r.text();
      expect(body).toContain("amicode-app-shelf-needs-setup");
      expect(body).toContain("build:app");
      // The /amicode/* surface is unaffected by the missing dist.
      const profile = await fetch(bareBase + "/amicode/profile", { headers: { Authorization: bare.authHeader } });
      expect(profile.status).toBe(200);
      expect((await profile.json()).ok).toBe(true);
    } finally {
      await bare.stop();
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it("without the shelf option the service keeps its pre-#822 fallback (no static serving)", async () => {
    const bare = createAmicodeService({ password: "shelf-absent-password" });
    const bareBase = (await bare.start()).toString().replace(/\/$/, "");
    try {
      const r = await fetch(bareBase + "/", { headers: { Authorization: bare.authHeader, Accept: "text/html" } });
      expect(r.status).toBe(503); // honest no-engine answer, NOT a static doc
    } finally {
      await bare.stop();
    }
  });
});
