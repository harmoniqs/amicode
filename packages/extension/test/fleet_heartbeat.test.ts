import { describe, it, expect, vi, beforeEach } from "vitest";
import { FleetHeartbeat, HEARTBEAT_INTERVAL_MS } from "../src/fleet_heartbeat";

function makeDeps(overrides: Record<string, unknown> = {}) {
  const NOW = Date.parse("2026-09-20T12:00:00.000Z");
  return {
    resolveIdentity: vi.fn(() => ({
      machine_id: "mac-studio-01",
      name: "Mac Studio",
      server_mode: "server",
      capabilities: ["compute"],
      device_type: "desktop",
      sshAlias: "mac-studio-01",
      transport: "ssh",
    })),
    fetchImpl: vi.fn(async () => ({ ok: true })),
    serviceUrl: "http://127.0.0.1:4095",
    authHeader: "Bearer test-token",
    now: () => NOW,
    intervalMs: 100, // fast for tests
    timer: { setInterval: vi.fn(() => 42), clearInterval: vi.fn() },
    ...overrides,
  };
}

describe("FleetHeartbeat (#1375)", () => {
  it("tick POSTs a well-formed roster row to /amicode/roster", async () => {
    const deps = makeDeps();
    const hb = new FleetHeartbeat(deps as any);
    await hb.tick();
    expect(deps.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, opts] = deps.fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:4095/amicode/roster");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer test-token");
    const body = JSON.parse(opts.body);
    expect(body.machine_id).toBe("mac-studio-01");
    expect(body.name).toBe("Mac Studio");
    expect(body.server_mode).toBe("server");
    expect(body.sshAlias).toBe("mac-studio-01");
    expect(body.transport).toBe("ssh");
  });

  it("tick sends health: 'reachable' and a fresh last_report", async () => {
    const NOW = Date.parse("2026-09-20T12:00:00.000Z");
    const deps = makeDeps({ now: () => NOW });
    const hb = new FleetHeartbeat(deps as any);
    await hb.tick();
    const body = JSON.parse(deps.fetchImpl.mock.calls[0][1].body);
    expect(body.health).toBe("reachable");
    expect(body.last_report).toBe(new Date(NOW).toISOString());
  });

  it("start fires immediately then on interval", () => {
    const deps = makeDeps();
    const hb = new FleetHeartbeat(deps as any);
    hb.start();
    // resolveIdentity called immediately on tick
    expect(deps.resolveIdentity).toHaveBeenCalledTimes(1);
    // setInterval called once
    expect(deps.timer.setInterval).toHaveBeenCalledTimes(1);
    expect(deps.timer.setInterval).toHaveBeenCalledWith(expect.any(Function), 100);
  });

  it("stop clears the interval", () => {
    const deps = makeDeps();
    const hb = new FleetHeartbeat(deps as any);
    hb.start();
    hb.stop();
    expect(deps.timer.clearInterval).toHaveBeenCalledWith(42);
  });

  it("no-op when resolveIdentity returns null", async () => {
    const deps = makeDeps({ resolveIdentity: vi.fn(() => null) });
    const hb = new FleetHeartbeat(deps as any);
    await hb.tick();
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });

  it("swallows fetch errors silently", async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn(async () => { throw new Error("ECONNREFUSED"); }),
    });
    const hb = new FleetHeartbeat(deps as any);
    // Must not throw
    await expect(hb.tick()).resolves.toBeUndefined();
  });

  it("start is idempotent — second call does not create another interval", () => {
    const deps = makeDeps();
    const hb = new FleetHeartbeat(deps as any);
    hb.start();
    hb.start();
    expect(deps.timer.setInterval).toHaveBeenCalledTimes(1);
  });

  it("dispose aliases stop", () => {
    const deps = makeDeps();
    const hb = new FleetHeartbeat(deps as any);
    hb.start();
    hb.dispose();
    expect(deps.timer.clearInterval).toHaveBeenCalledWith(42);
  });
});
