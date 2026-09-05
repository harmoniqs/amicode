// amicode_service wiring tests (#451, M1; #822 adds the engine/shelf boot
// shape) — the activation/lifecycle slice: boot on an ephemeral port, serve a
// route with the per-boot auth, export the terminal-env handle shape, dispose
// cleanly, and NEVER throw into activation (a boot failure logs and returns
// undefined — parallel-run means the service is additive, never load-bearing,
// until the M3 cutover). The #822 tests cover the full boot: engine context
// (late-bound URL getter + engine mint) and the app dist root both reach the
// booted service — against a mock engine upstream (node:http), per the issue's
// Testing Decisions.
import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { amicodeServiceDisposal, startAmicodeService } from "../src/amicode_service_wiring";
import { serverAuthHeader } from "../src/server_auth";

const sinkLog = () => {
  const lines: string[] = [];
  return { lines, log: { appendLine: (l: string) => lines.push(l) } };
};

/** A one-endpoint mock engine: /probe answers JSON so the wiring test can see
 *  the proxy actually reaching the upstream handed in at boot. */
async function startMockEngine(): Promise<{ url: string; stop(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/probe") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, upstream: true }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, stop: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("startAmicodeService", () => {
  it("boots on an ephemeral loopback port, serves a route with the per-boot auth, and logs the URL", async () => {
    const { lines, log } = sinkLog();
    const boot = await startAmicodeService(log);
    expect(boot).toBeDefined();
    if (!boot) return;
    try {
      expect(boot.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(boot.authHeader).toMatch(/^Basic /);
      expect(lines.some((l) => l.includes("[amicode-service] parallel-run"))).toBe(true);
      // The service answers (profile route shape — ok:true, fork contract).
      const r = await fetch(`${boot.url}/amicode/profile`, { headers: { Authorization: boot.authHeader } });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
      // 401 without the credential — the fork's auth discipline.
      const anon = await fetch(`${boot.url}/amicode/profile`);
      expect(anon.status).toBe(401);
    } finally {
      await boot.service.stop();
    }
  });

  it("disposal stops the service (and is a no-op for a failed boot)", async () => {
    const { log } = sinkLog();
    const boot = await startAmicodeService(log);
    if (!boot) throw new Error("boot unexpectedly failed");
    const url = boot.url;
    amicodeServiceDisposal(boot).dispose();
    // The port closes asynchronously — poll briefly for the refusal.
    let closed = false;
    for (let i = 0; i < 20 && !closed; i++) {
      try {
        await fetch(url);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        closed = true;
      }
    }
    expect(closed).toBe(true);
    // Failed boot → disposal is a safe no-op.
    expect(() => amicodeServiceDisposal(undefined).dispose()).not.toThrow();
  });

  it("#822 wires the engine context + app dist root: engine token works on /amicode/*, the proxy reaches the CURRENT upstream (late-bound), and the shelf serves the dist", async () => {
    const { lines, log } = sinkLog();
    const engine = await startMockEngine();
    // The late-bound getter contract: a variable the "restart" reassigns —
    // the proxy must read it PER REQUEST, never capture the boot-time value.
    let currentUrl: string | undefined = engine.url;
    const root = mkdtempSync(join(tmpdir(), "amicode-wiring-"));
    const dist = join(root, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><html><body><div id=root>wired</div></body></html>");
    const boot = await startAmicodeService(log, {
      engine: { password: "engine-wiring-mint", getUrl: () => currentUrl },
      appDistRoot: dist,
    });
    expect(boot).toBeDefined();
    if (!boot) return;
    try {
      expect(lines.some((l) => l.includes("engine proxy armed"))).toBe(true);
      expect(lines.some((l) => l.includes("app shelf mounted"))).toBe(true);
      const engineAuth = serverAuthHeader("engine-wiring-mint");
      // Engine token on an /amicode/* route (accept-both auth through the wiring).
      const route = await fetch(`${boot.url}/amicode/profile`, { headers: { Authorization: engineAuth } });
      expect(route.status).toBe(200);
      expect(((await route.json()) as { ok: boolean }).ok).toBe(true);
      // Proxied path through to the upstream handed in at boot.
      const via1 = await fetch(`${boot.url}/probe`, { headers: { Authorization: engineAuth } });
      expect(via1.status).toBe(200);
      expect(((await via1.json()) as { upstream?: boolean }).upstream).toBe(true);
      // The app document from the shelf.
      const doc = await fetch(`${boot.url}/`, {
        headers: { Authorization: engineAuth, Accept: "text/html" },
      });
      expect(doc.status).toBe(200);
      expect(await doc.text()).toContain("wired");
      // The restart gap: getter yields undefined → the honest 503, and the
      // /amicode/* route table is unaffected (the shelf/proxy never shadow it).
      currentUrl = undefined;
      const gap = await fetch(`${boot.url}/probe`, { headers: { Authorization: engineAuth } });
      expect(gap.status).toBe(503);
      const stillOk = await fetch(`${boot.url}/amicode/profile`, { headers: { Authorization: engineAuth } });
      expect(stillOk.status).toBe(200);
    } finally {
      await boot.service.stop();
      await engine.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("#822 without options the boot keeps its pre-#822 shape (no engine note, no shelf)", async () => {
    const { lines, log } = sinkLog();
    const boot = await startAmicodeService(log);
    expect(boot).toBeDefined();
    if (!boot) return;
    try {
      const joined = lines.join("\n");
      expect(joined).toContain("auth: per-boot Basic)");
      expect(joined).not.toContain("engine proxy armed");
      expect(joined).not.toContain("app shelf mounted");
      // No shelf → a document GET is NOT a static doc (honest 503, no engine).
      const r = await fetch(`${boot.url}/`, { headers: { Authorization: boot.authHeader, Accept: "text/html" } });
      expect(r.status).toBe(503);
    } finally {
      await boot.service.stop();
    }
  });
});
