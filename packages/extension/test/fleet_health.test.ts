import { describe, it, expect } from "vitest";
import { checkFleetGuard, checkFleetSettings, checkFleetTunnel, checkFleetRole, fleetHealthReport, FLEET_GUARD_INSTALL } from "../src/fleet_health";
import type { FleetTopologyState } from "../src/fleet_topology";

const REPO = "/repo/tools/fleet/amico-opencode-fleet-guard";
const INSTALLED = FLEET_GUARD_INSTALL;
const guardContent = "#!/bin/bash\nexit 1\n";

/** #1106 (P3b-2): the health checks consume the projection-cache topology
 *  state — never the raw fleet.json. These builders are the same states
 *  readFleetTopology returns; the checks must render each honestly. */
const okClient: FleetTopologyState = {
  kind: "ok",
  role: "client",
  canonical: { host: "test", port: 4096, sshAlias: "test" },
  mode: "fleet",
  posture: "ok",
  freshness: { counter: 7, hubEpoch: "44444444-4444-4444-8444-444444444444" },
  provenanceSource: "fleet.json",
  projection: { schema_version: 1, contract_version: 1, sections: {} },
};
const okStandalone: FleetTopologyState = {
  kind: "ok",
  role: "standalone",
  mode: "standalone",
  posture: "ok",
  freshness: {},
  provenanceSource: "base default (mode absent = standalone)",
  projection: { schema_version: 1, contract_version: 1, sections: {} },
};
const okServer: FleetTopologyState = {
  kind: "ok",
  role: "server",
  canonical: { host: "studio", port: 4096, sshAlias: "studio" },
  mode: "fleet",
  posture: "ok",
  freshness: { counter: 3, hubEpoch: "55555555-5555-5555-8555-555555555555" },
  provenanceSource: "fleet.json",
  projection: { schema_version: 1, contract_version: 1, sections: {} },
};
const absent: FleetTopologyState = {
  kind: "absent",
  detail: "fleet projection absent at /tmp/projection.json — refresh it with `amico fleet status --projection`",
};
const broken: FleetTopologyState = {
  kind: "broken",
  detail: "projection carries contract v2; this consumer speaks v1 — refusing loudly",
};

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

  it("guard: RUNS on linux/WSL now (#1261 AC4) — no longer skipped; a stale guard is caught", () => {
    const c = checkFleetGuard(REPO, INSTALLED, {
      platform: "linux",
      read: (p) => p === REPO ? guardContent : guardContent + "drift",
      isExecutable: () => true,
    });
    expect(c.ok).toBe(false);
    expect(c.detail).not.toMatch(/skipped/);
    expect(c.detail).toMatch(/stale/);
  });

  it("settings: fails when binary not set", () => {
    const c = checkFleetSettings("", 4096, { platform: "darwin", topology: okClient });
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/not set/);
  });

  it("settings: fails when port wrong (the projection's canonical port is the truth)", () => {
    const c = checkFleetSettings(INSTALLED, 43117, { platform: "darwin", topology: okClient });
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/43117/);
  });

  it("settings: ok when guard + matching port", () => {
    const c = checkFleetSettings(INSTALLED, 4096, { platform: "darwin", topology: okClient });
    expect(c.ok).toBe(true);
  });

  it("settings: RUNS on linux/WSL now (#1261 AC4) — an unset binary on a client is caught, not skipped", () => {
    const c = checkFleetSettings("", 4096, { platform: "linux", topology: okClient });
    expect(c.ok).toBe(false);
    expect(c.detail).not.toMatch(/skipped/);
    expect(c.detail).toMatch(/not set/);
  });

  it("tunnel: fails when missing", () => {
    const c = checkFleetTunnel(null, { platform: "darwin", topology: okClient });
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/missing/);
  });

  it("tunnel: fails when stale 30/3", () => {
    const stale = `<string>ServerAliveInterval=30</string><string>ServerAliveCountMax=3</string>`;
    const c = checkFleetTunnel(stale, { platform: "darwin", topology: okClient });
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/30|stale/);
  });

  it("tunnel: ok when hardened", () => {
    const good = `ServerAliveInterval=15 ServerAliveCountMax=2 TCPKeepAlive=yes 127.0.0.1:4096:127.0.0.1:4096`;
    const c = checkFleetTunnel(good, { platform: "darwin", topology: okClient });
    expect(c.ok).toBe(true);
  });

  it("tunnel: skips on linux", () => {
    const c = checkFleetTunnel(null, { platform: "linux" });
    expect(c.ok).toBe(true);
  });

  it("role: ok-state standalone renders standalone", () => {
    const c = checkFleetRole({ platform: "darwin", topology: okStandalone });
    expect(c.ok).toBe(true);
    expect(c.detail).toMatch(/standalone/);
  });

  it("role: absent projection renders the base default standalone — with the refresh pointer, not silent", () => {
    const c = checkFleetRole({ platform: "darwin", topology: absent });
    expect(c.ok).toBe(true);
    expect(c.detail).toMatch(/standalone/);
    expect(c.detail).toMatch(/amico fleet status --projection/); // the pointer surfaces
  });

  it("role: a broken projection is a RENDERED fail state — the reader's rejection + the refresh fix, never silent standalone", () => {
    const c = checkFleetRole({ platform: "darwin", topology: broken });
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/refusing loudly/);
    expect(c.fix).toMatch(/amico fleet status --projection/);
  });

  it("role: the D1 freshness verdict surfaces in the detail (stale says what it is)", () => {
    const c = checkFleetRole({
      platform: "darwin",
      topology: { ...okClient, verdict: "stale", advisory: "stale — same counter as the previous fetch; nothing new was published" },
    });
    expect(c.ok).toBe(true);
    expect(c.detail).toMatch(/stale/);
  });

  it("role: client renders the canonical target from the projection", () => {
    const c = checkFleetRole({ platform: "darwin", topology: okClient });
    expect(c.ok).toBe(true);
    expect(c.detail).toMatch(/test:4096/);
  });

  it("aggregate report: standalone (ok state) skips guard/settings/tunnel", () => {
    const r = fleetHealthReport({
      repoGuardPath: REPO,
      configuredBinary: "", // would fail in client mode, but standalone skips
      configuredPort: 0,
      plistContent: null,
      read: () => { throw new Error("no file"); },
      isExecutable: () => true,
      platform: "darwin",
      topology: okStandalone,
    });
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe("Fleet role");
    expect(r[0].detail).toMatch(/standalone/);
  });

  it("aggregate report: server mode skips guard/settings/tunnel — servers run their own engine (ADR 0029)", () => {
    const r = fleetHealthReport({
      repoGuardPath: REPO,
      configuredBinary: "", // unset is fine on a server — it spawns the vendored binary
      configuredPort: 0,
      plistContent: null,
      read: () => { throw new Error("no file"); },
      isExecutable: () => true,
      platform: "darwin",
      topology: okServer,
    });
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe("Fleet role");
    expect(r[0].detail).toMatch(/server/);
  });

  it("aggregate report: absent projection → the standalone floor (only the role check), identical to the ok-standalone shape", () => {
    const r = fleetHealthReport({
      repoGuardPath: REPO,
      configuredBinary: "",
      configuredPort: 0,
      plistContent: null,
      read: () => { throw new Error("no file"); },
      isExecutable: () => true,
      platform: "darwin",
      topology: absent,
    });
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe("Fleet role");
    expect(r[0].detail).toMatch(/standalone/);
  });

  it("aggregate report: a broken projection surfaces as the role check's rendered fail, never a silent skip", () => {
    const r = fleetHealthReport({
      repoGuardPath: REPO,
      configuredBinary: INSTALLED,
      configuredPort: 4096,
      plistContent: `ServerAliveInterval=15 ServerAliveCountMax=2 TCPKeepAlive=yes 127.0.0.1:4096:127.0.0.1:4096`,
      read: () => guardContent,
      isExecutable: () => true,
      platform: "darwin",
      topology: broken,
    });
    expect(r).toHaveLength(1);
    expect(r[0].ok).toBe(false);
    expect(r[0].detail).toMatch(/refusing loudly/);
  });

  it("aggregate report: client mode returns role + guard + settings + tunnel", () => {
    const r = fleetHealthReport({
      repoGuardPath: REPO,
      configuredBinary: INSTALLED,
      configuredPort: 4096,
      plistContent: `ServerAliveInterval=15 ServerAliveCountMax=2 TCPKeepAlive=yes 127.0.0.1:4096:127.0.0.1:4096`,
      read: () => guardContent,
      isExecutable: () => true,
      platform: "darwin",
      topology: okClient,
    });
    expect(r).toHaveLength(4);
    expect(r.every(c => c.ok)).toBe(true);
  });
});

// ── #1261 AC4: the guard/settings/role checks RUN on linux (WSL) too; only
// the launchd-plist TUNNEL check stays darwin-specific (deferring to #1260) ──
describe("fleet_health on linux — the guard backstop is wired cross-platform (#1261 AC4)", () => {
  it("guard: ok on linux when installed + in sync (runs, not skipped)", () => {
    const c = checkFleetGuard(REPO, INSTALLED, { platform: "linux", read: () => guardContent, isExecutable: () => true });
    expect(c.ok).toBe(true);
    expect(c.detail).not.toMatch(/skipped/);
  });

  it("settings: ok on linux when guard + matching port", () => {
    const c = checkFleetSettings(INSTALLED, 4096, { platform: "linux", topology: okClient });
    expect(c.ok).toBe(true);
  });

  it("role: RUNS on linux — a client renders its canonical target, not a skip", () => {
    const c = checkFleetRole({ platform: "linux", topology: okClient });
    expect(c.ok).toBe(true);
    expect(c.detail).not.toMatch(/skipped/);
    expect(c.detail).toMatch(/test:4096/);
  });

  it("tunnel: STILL skips on linux — the launchd plist is darwin-specific (#1260 owns the linux tunnel)", () => {
    const c = checkFleetTunnel(null, { platform: "linux", topology: okClient });
    expect(c.ok).toBe(true);
    expect(c.detail).toMatch(/skipped/);
  });

  it("aggregate report on linux: a client runs role + guard + settings (tunnel self-skips) — not an all-skip", () => {
    const r = fleetHealthReport({
      repoGuardPath: REPO,
      configuredBinary: "", // wrong on a client — must be caught on linux now
      configuredPort: 4096,
      plistContent: null,
      read: () => guardContent,
      isExecutable: () => true,
      platform: "linux",
      topology: okClient,
    });
    expect(r).toHaveLength(4);
    const settings = r.find((c) => c.name === "Fleet settings")!;
    expect(settings.ok).toBe(false); // the unset binary is CAUGHT on linux
    const tunnel = r.find((c) => c.name === "Fleet tunnel")!;
    expect(tunnel.detail).toMatch(/skipped/); // …but the tunnel stays darwin-only
  });

  it("aggregate report on linux: standalone → only the role check (the base floor, cross-platform)", () => {
    const r = fleetHealthReport({
      repoGuardPath: REPO,
      configuredBinary: "",
      configuredPort: 0,
      plistContent: null,
      read: () => { throw new Error("no file"); },
      isExecutable: () => true,
      platform: "linux",
      topology: okStandalone,
    });
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe("Fleet role");
    expect(r[0].detail).toMatch(/standalone/);
  });
});
