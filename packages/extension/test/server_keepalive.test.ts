import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  startKeepalive,
  stopKeepalive,
  readGraceSeconds,
  type KeepaliveDeps,
} from "../src/server_keepalive";

// ============================================================================
// Helpers
// ============================================================================

function fakeDeps(overrides?: Partial<KeepaliveDeps>): KeepaliveDeps {
  return {
    pingServer: vi.fn<[number, string, number], Promise<boolean>>().mockResolvedValue(true),
    onServerGone: vi.fn(),
    log: vi.fn(),
    ...overrides,
  };
}

// ============================================================================
// AC1: startKeepalive fires pings at interval
// ============================================================================

describe("startKeepalive — fires pings at interval", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    stopKeepalive();
    vi.useRealTimers();
  });

  it("sends a ping immediately and then on each interval tick", async () => {
    const deps = fakeDeps();
    startKeepalive({ port: 43117, password: "pw", graceSeconds: 30, deps });

    // Immediate ping
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.pingServer).toHaveBeenCalledTimes(1);
    expect(deps.pingServer).toHaveBeenCalledWith(43117, "pw", 30);

    // After one interval (10s)
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.pingServer).toHaveBeenCalledTimes(2);

    // After another interval
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.pingServer).toHaveBeenCalledTimes(3);
  });
});

// ============================================================================
// AC2: stopKeepalive clears interval — no more pings after stop
// ============================================================================

describe("stopKeepalive — clears interval", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    stopKeepalive();
    vi.useRealTimers();
  });

  it("stops pinging after stopKeepalive is called", async () => {
    const deps = fakeDeps();
    startKeepalive({ port: 43117, password: "pw", graceSeconds: 30, deps });

    await vi.advanceTimersByTimeAsync(0); // immediate ping
    expect(deps.pingServer).toHaveBeenCalledTimes(1);

    stopKeepalive();

    // Advance well past multiple intervals — no new pings
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.pingServer).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// AC3: Grace window reads from config, defaults to 30
// ============================================================================

describe("readGraceSeconds — config reading", () => {
  it("defaults to 30 when the setting is unset (undefined)", () => {
    const cfg = { get: vi.fn().mockReturnValue(undefined) };
    expect(readGraceSeconds(cfg as any)).toBe(30);
  });

  it("defaults to 30 when the setting is 0", () => {
    const cfg = { get: vi.fn().mockReturnValue(0) };
    expect(readGraceSeconds(cfg as any)).toBe(30);
  });

  it("returns the configured value when set", () => {
    const cfg = { get: vi.fn().mockReturnValue(60) };
    expect(readGraceSeconds(cfg as any)).toBe(60);
  });

  it("enforces a minimum of 10 seconds", () => {
    const cfg = { get: vi.fn().mockReturnValue(5) };
    expect(readGraceSeconds(cfg as any)).toBe(10);
  });
});

// ============================================================================
// AC4: Server-gone (connection refused) triggers handshake cleanup
// ============================================================================

describe("startKeepalive — server-gone detection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    stopKeepalive();
    vi.useRealTimers();
  });

  it("calls onServerGone when the ping fails (connection refused)", async () => {
    const deps = fakeDeps({
      pingServer: vi.fn<[number, string, number], Promise<boolean>>().mockResolvedValue(false),
    });
    startKeepalive({ port: 43117, password: "pw", graceSeconds: 30, deps });

    // Let the immediate ping fire and settle
    await vi.advanceTimersByTimeAsync(0);
    // Allow the promise to resolve
    await vi.advanceTimersByTimeAsync(1);

    expect(deps.onServerGone).toHaveBeenCalledTimes(1);
  });

  it("does NOT call onServerGone when pings succeed", async () => {
    const deps = fakeDeps({
      pingServer: vi.fn<[number, string, number], Promise<boolean>>().mockResolvedValue(true),
    });
    startKeepalive({ port: 43117, password: "pw", graceSeconds: 30, deps });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(deps.onServerGone).not.toHaveBeenCalled();
  });

  it("stops pinging after server-gone is detected", async () => {
    const deps = fakeDeps({
      pingServer: vi.fn<[number, string, number], Promise<boolean>>().mockResolvedValue(false),
    });
    startKeepalive({ port: 43117, password: "pw", graceSeconds: 30, deps });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.onServerGone).toHaveBeenCalledTimes(1);

    // Advance many intervals — no further pings or onServerGone calls
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.pingServer).toHaveBeenCalledTimes(1);
    expect(deps.onServerGone).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// AC5: Keepalive passes graceSeconds to the ping
// ============================================================================

describe("startKeepalive — grace window propagation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    stopKeepalive();
    vi.useRealTimers();
  });

  it("passes the configured graceSeconds to each ping", async () => {
    const deps = fakeDeps();
    startKeepalive({ port: 43117, password: "pw", graceSeconds: 45, deps });

    await vi.advanceTimersByTimeAsync(0);
    expect(deps.pingServer).toHaveBeenCalledWith(43117, "pw", 45);
  });
});

// ============================================================================
// AC6: Multiple startKeepalive calls replace the previous one
// ============================================================================

describe("startKeepalive — idempotency", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    stopKeepalive();
    vi.useRealTimers();
  });

  it("stops the previous keepalive when started again", async () => {
    const deps1 = fakeDeps();
    const deps2 = fakeDeps();
    startKeepalive({ port: 43117, password: "pw1", graceSeconds: 30, deps: deps1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(deps1.pingServer).toHaveBeenCalledTimes(1);

    // Start a new keepalive — old one should be replaced
    startKeepalive({ port: 43118, password: "pw2", graceSeconds: 30, deps: deps2 });
    await vi.advanceTimersByTimeAsync(0);

    // Advance past interval — only deps2 should get more pings
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps1.pingServer).toHaveBeenCalledTimes(1); // no more after replaced
    expect(deps2.pingServer).toHaveBeenCalledTimes(2); // immediate + 1 tick
  });
});
