// amicode_service_boot_probe — the #822 env-gated LIVE boot proof ENTRY
// (bundled + spawned by scripts/amicode_service_boot_probe.mjs; do not run
// by hand — the wrapper carries the env gating). Boots the REAL service
// (this same source, esbuild-bundled — no transcribed logic) against a REAL
// spawned engine (the vendored opencode binary, password-armed) and a REAL
// built app dist, then asserts the four end-to-end surfaces from the service
// origin, all with the ENGINE credential (the framed app's bootstrap):
//
//   1. the app document from the shelf (200 text/html, NOT the placeholder)
//   2. an engine API call through the proxy (GET /session, real engine answer)
//   3. an SSE connect through the proxy (GET /event, text/event-stream)
//   4. one /amicode/* route (GET /amicode/profile, ok:true)
//
// CI never runs this (no dist there until the packaging-chore issue lands —
// the wrapper skips honestly); the gate runs it once for real. The vitest
// suite covers the contract with mock engine + mock dist.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createAmicodeService } from "./amicode_service";
import { APP_SHELF_NEEDS_SETUP_MARKER } from "./amicode_service/app_shelf";
import { serverAuthHeader } from "./server_auth";

const APP_DIST = (process.env.AMICODE_APP_DIST ?? "").trim();
const ENGINE_BIN = (process.env.AMICODE_ENGINE_BIN ?? "").trim();
const ENGINE_PASSWORD = "amicode-boot-probe-engine-mint";

const fail = (msg: string): never => {
  console.error(`[boot-probe] FAIL: ${msg}`);
  process.exit(1);
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address();
      if (typeof p === "object" && p) srv.close(() => resolve(p.port));
      else srv.close(), reject(new Error("no port"));
    });
    srv.on("error", reject);
  });
}

async function main(): Promise<void> {
  if (APP_DIST === "" || ENGINE_BIN === "") fail("AMICODE_APP_DIST / AMICODE_ENGINE_BIN missing (the wrapper gates these)");

  // ── boot the engine (the ServerManager spawn idiom, password-armed) ────────
  const proj = mkdtempSync(join(tmpdir(), "amicode-boot-probe-engine-"));
  mkdirSync(join(proj, ".opencode"), { recursive: true });
  writeFileSync(join(proj, "AGENTS.md"), "# amicode boot probe\n");
  writeFileSync(join(proj, ".opencode", "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2));

  const enginePort = await freePort();
  const engineUrl = `http://127.0.0.1:${enginePort}`;
  let engineLog = "";
  const engine: ChildProcess = spawn(ENGINE_BIN, ["serve", "--port", String(enginePort)], {
    cwd: proj,
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: ENGINE_PASSWORD },
    stdio: ["ignore", "pipe", "pipe"],
  });
  engine.stdout?.on("data", (d: Buffer) => (engineLog += d));
  engine.stderr?.on("data", (d: Buffer) => (engineLog += d));
  const engineAuth = serverAuthHeader(ENGINE_PASSWORD);

  // ── boot the REAL service: shelf + engine proxy + engine-token auth ───────
  const service = createAmicodeService({
    engine: { password: ENGINE_PASSWORD, getUrl: () => engineUrl },
    shelf: { distRoot: APP_DIST },
  });
  const origin = (await service.start()).toString().replace(/\/$/, "");

  try {
    // Engine readiness (the ServerManager health-probe idiom: WITH the armed
    // credential, else a healthy boot 401s and reads as a timeout).
    let up = false;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !up) {
      try {
        const r = await fetch(`${engineUrl}/`, { headers: { Authorization: engineAuth }, signal: AbortSignal.timeout(500) });
        if (r.status < 500) up = true;
      } catch {
        /* not up yet */
      }
      if (!up) await new Promise((r) => setTimeout(r, 250));
    }
    if (!up) fail(`engine not up within 30s\n--- engine output ---\n${engineLog}`);
    console.log(`[boot-probe] engine up at ${engineUrl}`);

    // 1. the app document from the service origin (the shelf, not the proxy).
    const doc = await fetch(`${origin}/`, { headers: { Authorization: engineAuth, Accept: "text/html" } });
    const docBody = await doc.text();
    if (doc.status !== 200) fail(`GET / → ${doc.status}, want 200`);
    if (!(doc.headers.get("content-type") ?? "").includes("text/html")) fail(`GET / content-type: ${doc.headers.get("content-type")}`);
    if (docBody.includes(APP_SHELF_NEEDS_SETUP_MARKER))
      fail("GET / served the NEEDS-SETUP placeholder — the dist did not reach the shelf");
    console.log(`[boot-probe] ✓ app document from the service origin (${docBody.length} bytes, not the placeholder)`);

    // 2. an engine API call through the proxy (the real engine answers).
    const session = await fetch(`${origin}/session`, { headers: { Authorization: engineAuth } });
    if (session.status !== 200) fail(`proxied GET /session → ${session.status}, want 200 (the real engine's answer)`);
    const sessions = (await session.json().catch(() => undefined)) as unknown;
    if (!(session.headers.get("content-type") ?? "").includes("application/json") || sessions === undefined)
      fail("proxied GET /session did not answer the engine's JSON");
    console.log("[boot-probe] ✓ engine API call through the proxy (GET /session)");

    // 3. an SSE connect through the proxy (unbuffered stream).
    const sse = await fetch(`${origin}/event`, { headers: { Authorization: engineAuth } });
    if (sse.status !== 200) fail(`proxied GET /event → ${sse.status}, want 200`);
    if (!(sse.headers.get("content-type") ?? "").includes("text/event-stream"))
      fail(`proxied GET /event content-type: ${sse.headers.get("content-type")}, want text/event-stream`);
    {
      // Read the FIRST chunk then stop — the connect is what's under test.
      const reader = sse.body!.getReader();
      const { value } = await reader.read();
      if (!value || value.length === 0) fail("proxied SSE stream delivered an empty first chunk");
      await reader.cancel().catch(() => undefined);
    }
    console.log("[boot-probe] ✓ SSE connect through the proxy (GET /event, first chunk delivered)");

    // 4. one /amicode/* route with the ENGINE credential (accept-both auth).
    const profile = await fetch(`${origin}/amicode/profile`, { headers: { Authorization: engineAuth } });
    if (profile.status !== 200) fail(`GET /amicode/profile → ${profile.status}, want 200`);
    if (((await profile.json()) as { ok?: boolean }).ok !== true) fail("GET /amicode/profile did not answer the service's ok:true shape");
    console.log("[boot-probe] ✓ /amicode/* route with the engine credential (GET /amicode/profile)");

    console.log("[boot-probe] PASS — the service origin serves the app, fronts the engine, and owns /amicode/*");
  } finally {
    await service.stop();
    try {
      engine.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      try {
        engine.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 3000).unref();
  }
}

void main();
