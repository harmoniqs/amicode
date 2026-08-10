import { describe, it, expect } from "vitest";
import { checkFleetGuard, checkFleetSettings, checkFleetTunnel, fleetHealthReport, FLEET_GUARD_INSTALL } from "../src/fleet_health";

const REPO = "/repo/tools/fleet/amico-opencode-fleet-guard";
const INSTALLED = FLEET_GUARD_INSTALL;
const guardContent = "#!/bin/bash\nexit 1\n";

describe("fleet_health", () => {
  it("guard: ok when in sync and executable (darwin)", () => {
    const c = checkFleetGuard(REPO, INSTALLED, {
      platform: "darwin",
      read: () => guardContent,
      isExecutable: () => true,
    });
    expect(c.ok).toBe(true);
  });

  it("guard: fails when not installed", () => {
    const c = checkFleetGuard(REPO, INSTALLED, {
      platform: "darwin",
      read: (p) => { if (p === REPO) return guardContent; throw new Error("missing"); },
      isExecutable: () => true,
    });
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/not installed/);
    expect(c.fix).toMatch(/install\.sh/);
  });

  it("guard: fails when stale", () => {
    const c = checkFleetGuard(REPO, INSTALLED, {
      platform: "darwin",
      read: (p) => p === REPO ? guardContent : guardContent + "drift",
      isExecutable: () => true,
    });
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/stale/);
  });

  it("guard: skips on linux", () => {
    const c = checkFleetGuard(REPO, INSTALLED, { platform: "linux", read: () => { throw new Error("no read on linux"); } });
    expect(c.ok).toBe(true);
    expect(c.detail).toMatch(/skipped/);
  });

  it("settings: fails when binary not set", () => {
    const c = checkFleetSettings("", 4096, { platform: "darwin" });
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/not set/);
  });

  it("settings: fails when port wrong", () => {
    const c = checkFleetSettings(INSTALLED, 43117, { platform: "darwin" });
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/43117/);
  });

  it("settings: ok when guard + 4096", () => {
    const c = checkFleetSettings(INSTALLED, 4096, { platform: "darwin" });
    expect(c.ok).toBe(true);
  });

  it("settings: skips on linux", () => {
    const c = checkFleetSettings("", 0, { platform: "linux" });
    expect(c.ok).toBe(true);
  });

  it("tunnel: fails when missing", () => {
    const c = checkFleetTunnel(null, { platform: "darwin" });
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/missing/);
  });

  it("tunnel: fails when stale 30/3", () => {
    const stale = `<string>ServerAliveInterval=30</string><string>ServerAliveCountMax=3</string>`;
    const c = checkFleetTunnel(stale, { platform: "darwin" });
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/30|stale/);
  });

  it("tunnel: ok when hardened", () => {
    const good = `ServerAliveInterval=15 ServerAliveCountMax=2 TCPKeepAlive=yes 127.0.0.1:4096:127.0.0.1:4096`;
    const c = checkFleetTunnel(good, { platform: "darwin" });
    expect(c.ok).toBe(true);
  });

  it("tunnel: skips on linux", () => {
    const c = checkFleetTunnel(null, { platform: "linux" });
    expect(c.ok).toBe(true);
  });

  it("aggregate report has 3 checks", () => {
    const r = fleetHealthReport({
      repoGuardPath: REPO,
      configuredBinary: INSTALLED,
      configuredPort: 4096,
      plistContent: `ServerAliveInterval=15 ServerAliveCountMax=2 TCPKeepAlive=yes 127.0.0.1:4096:127.0.0.1:4096`,
      read: () => guardContent,
      isExecutable: () => true,
      platform: "darwin",
    });
    expect(r).toHaveLength(3);
    expect(r.every(c => c.ok)).toBe(true);
  });
});
