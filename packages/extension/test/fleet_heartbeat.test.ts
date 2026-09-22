import { describe, it, expect, vi, beforeEach } from "vitest";
import { FleetHeartbeat, HEARTBEAT_INTERVAL_MS, resolveTailscaleDnsName, pushRowToPeer } from "../src/fleet_heartbeat";

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

  it("tick includes peer_origin in the roster row when identity provides one", async () => {
    const deps = makeDeps({
      resolveIdentity: vi.fn(() => ({
        machine_id: "mac-studio-01",
        name: "Mac Studio",
        server_mode: "server",
        capabilities: ["serving"],
        device_type: "desktop",
        sshAlias: "jjs-mac-studio",
        transport: "tailscale",
        peer_origin: "https://jjs-mac-studio.tail570504.ts.net",
      })),
    });
    const hb = new FleetHeartbeat(deps as any);
    await hb.tick();
    const body = JSON.parse(deps.fetchImpl.mock.calls[0][1].body);
    expect(body.transport).toBe("tailscale");
    expect(body.peer_origin).toBe("https://jjs-mac-studio.tail570504.ts.net");
  });

  it("tick omits peer_origin from the roster row when identity does not provide one", async () => {
    const deps = makeDeps(); // default identity has no peer_origin
    const hb = new FleetHeartbeat(deps as any);
    await hb.tick();
    const body = JSON.parse(deps.fetchImpl.mock.calls[0][1].body);
    expect(body.transport).toBe("ssh");
    expect(body.peer_origin).toBeUndefined();
    expect("peer_origin" in body).toBe(false);
  });

  it("tick calls pushToPeers with the serialized row when wired", async () => {
    const pushToPeers = vi.fn(async () => {});
    const deps = makeDeps({ pushToPeers });
    const hb = new FleetHeartbeat(deps as any);
    await hb.tick();
    expect(pushToPeers).toHaveBeenCalledTimes(1);
    const rowJson = pushToPeers.mock.calls[0][0];
    const row = JSON.parse(rowJson);
    expect(row.machine_id).toBe("mac-studio-01");
    expect(row.health).toBe("reachable");
  });

  it("tick swallows pushToPeers errors independently of the local POST", async () => {
    const pushToPeers = vi.fn(async () => { throw new Error("peer unreachable"); });
    const deps = makeDeps({ pushToPeers });
    const hb = new FleetHeartbeat(deps as any);
    await expect(hb.tick()).resolves.toBeUndefined();
    // Local POST still happened
    expect(deps.fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("resolveTailscaleDnsName", () => {
  it("extracts the MagicDNS name from tailscale status --self --json", () => {
    const mockOutput = JSON.stringify({
      Self: { DNSName: "jjs-mac-studio.tail570504.ts.net.", TailscaleIPs: ["100.77.141.50"] },
    });
    const dns = resolveTailscaleDnsName(() => mockOutput);
    expect(dns).toBe("jjs-mac-studio.tail570504.ts.net");
  });

  it("strips the trailing dot from the DNS name", () => {
    const mockOutput = JSON.stringify({ Self: { DNSName: "host.example.ts.net." } });
    const dns = resolveTailscaleDnsName(() => mockOutput);
    expect(dns).toBe("host.example.ts.net");
  });

  it("returns undefined when tailscale CLI is not available", () => {
    const dns = resolveTailscaleDnsName(() => { throw new Error("command not found"); });
    expect(dns).toBeUndefined();
  });

  it("returns undefined when Self.DNSName is missing", () => {
    const dns = resolveTailscaleDnsName(() => JSON.stringify({ Self: {} }));
    expect(dns).toBeUndefined();
  });

  it("returns undefined when output is not valid JSON", () => {
    const dns = resolveTailscaleDnsName(() => "not json");
    expect(dns).toBeUndefined();
  });
});

describe("pushRowToPeer — transport-aware heartbeat push", () => {
  it("uses fetch for a peer with peer_origin (tailscale transport)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const execSsh = vi.fn();
    await pushRowToPeer({
      rowJson: '{"machine_id":"mbp"}',
      peer: { machine_id: "studio", sshAlias: "jjs-mac-studio", transport: "tailscale", peer_origin: "https://jjs-mac-studio.tail570504.ts.net" },
      localPort: 4096,
      fetchImpl,
      execSsh,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://jjs-mac-studio.tail570504.ts.net/amicode/roster");
    expect(opts.method).toBe("POST");
    expect(opts.body).toBe('{"machine_id":"mbp"}');
    expect(execSsh).not.toHaveBeenCalled();
  });

  it("uses SSH for a peer without peer_origin (ssh transport)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const execSsh = vi.fn();
    await pushRowToPeer({
      rowJson: '{"machine_id":"mbp"}',
      peer: { machine_id: "studio", sshAlias: "jjs-mac-studio", transport: "ssh" },
      localPort: 4096,
      fetchImpl,
      execSsh,
    });
    expect(execSsh).toHaveBeenCalledTimes(1);
    expect(execSsh.mock.calls[0][0]).toBe("jjs-mac-studio");
    expect(execSsh.mock.calls[0][1]).toContain("127.0.0.1:4096");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses SSH for a peer with transport=tailscale but no peer_origin (fallback)", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const execSsh = vi.fn();
    await pushRowToPeer({
      rowJson: '{"machine_id":"mbp"}',
      peer: { machine_id: "studio", sshAlias: "jjs-mac-studio", transport: "tailscale" },
      localPort: 4096,
      fetchImpl,
      execSsh,
    });
    expect(execSsh).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("swallows fetch errors silently", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("network error"); });
    const execSsh = vi.fn();
    // Must not throw
    await expect(pushRowToPeer({
      rowJson: '{"machine_id":"mbp"}',
      peer: { machine_id: "studio", sshAlias: "jjs-mac-studio", transport: "tailscale", peer_origin: "https://example.ts.net" },
      localPort: 4096,
      fetchImpl,
      execSsh,
    })).resolves.toBeUndefined();
  });

  it("uses fetch for a direct-transport peer with peer_origin", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const execSsh = vi.fn();
    await pushRowToPeer({
      rowJson: '{"machine_id":"mbp"}',
      peer: { machine_id: "studio", sshAlias: "jjs-mac-studio", transport: "direct", peer_origin: "https://10.0.0.5:4096" },
      localPort: 4096,
      fetchImpl,
      execSsh,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://10.0.0.5:4096/amicode/roster");
    expect(execSsh).not.toHaveBeenCalled();
  });
});
