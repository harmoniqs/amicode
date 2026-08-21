// amicode_service wiring tests (#451, M1) — the activation/lifecycle slice:
// boot on an ephemeral port, serve a route with the per-boot auth, export the
// terminal-env handle shape, dispose cleanly, and NEVER throw into activation
// (a boot failure logs and returns undefined — parallel-run means the service
// is additive, never load-bearing, until the M3 cutover).
import { describe, it, expect } from "vitest";
import { amicodeServiceDisposal, startAmicodeService } from "../src/amicode_service_wiring";

const sinkLog = () => {
  const lines: string[] = [];
  return { lines, log: { appendLine: (l: string) => lines.push(l) } };
};

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
});
