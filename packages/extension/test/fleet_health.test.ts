import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFleetGuard, checkFleetSettings, checkFleetTunnel, checkFleetRole, checkPeerForwards, fleetHealthReport, FLEET_GUARD_INSTALL } from "../src/fleet_health";
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

// ── #1775: every per-peer SSH forward agent is checked the way the hub tunnel is ──
// One launchd agent per attached peer (co.harmoniqs.amico-peer-<machine_id>-
// forward), enumerated by label convention from an INJECTED LaunchAgents dir;
// the attached peers come from the reader peer-token store (loopback base_url
// = the forward's local end). Missing or stale keepalive values fail with the
// install.sh fix line — the tunnel check's exact shape.
describe("#1775 peer forward agents — every per-peer forward is checked like the hub tunnel", () => {
  const TEMPLATE = readFileSync(join(__dirname, "..", "..", "..", "tools", "fleet", "co.harmoniqs.amico-peer-forward.plist"), "utf8");
  let root: string;
  let launchAgentsDir: string;
  let peerStoreFile: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fleet-health-peers-"));
    launchAgentsDir = join(root, "LaunchAgents");
    mkdirSync(launchAgentsDir, { recursive: true });
    peerStoreFile = join(root, "fleet-peer-tokens-reader.json");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** The agent exactly as the installer renders it from the repo template. */
  const rendered = (id: string, localPort: number, remotePort = 4096, alias = id): string =>
    TEMPLATE.replace(/PEER_MACHINE_ID/g, id)
      .replace(/PEER_LOCAL_PORT/g, String(localPort))
      .replace(/PEER_REMOTE_PORT/g, String(remotePort))
      .replace(/PEER_SSH_ALIAS/g, alias);
  const placeAgent = (file: string, content: string): void => writeFileSync(join(launchAgentsDir, file), content);
  const managedFile = (id: string): string => `co.harmoniqs.amico-peer-${id}-forward.plist`;
  const attach = (peers: Record<string, string>): void =>
    writeFileSync(peerStoreFile, JSON.stringify({ store_version: 1, peers: Object.fromEntries(Object.entries(peers).map(([id, u]) => [id, { base_url: u, token: "t" }])) }));
  const run = (topology: FleetTopologyState = okServer) =>
    checkPeerForwards({ launchAgentsDir, peerStoreFile, platform: "darwin", topology });

  it("one check per attached peer: an installer-rendered agent passes with the tunnel's ok shape (15/2 + TCPKeepAlive, the forward)", () => {
    attach({ "jjs-mac-studio": "http://127.0.0.1:45096" });
    placeAgent(managedFile("jjs-mac-studio"), rendered("jjs-mac-studio", 45096));
    const checks = run();
    expect(checks).toHaveLength(1);
    expect(checks[0].name).toBe("Fleet peer forward (jjs-mac-studio)");
    expect(checks[0].ok).toBe(true);
    expect(checks[0].detail).toMatch(/ServerAlive 15\/2 \+ TCPKeepAlive/);
    expect(checks[0].detail).toContain("127.0.0.1:45096:127.0.0.1:4096");
  });

  it("an attached peer with NO forward agent fails, naming the agent, with the install.sh fix line", () => {
    attach({ "jjs-mac-studio": "http://127.0.0.1:45096" });
    const [c] = run();
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/missing/);
    expect(c.detail).toContain(managedFile("jjs-mac-studio"));
    expect(c.fix).toMatch(/bash tools\/fleet\/install\.sh/);
  });

  it("several agents, stale values: each is reported; each stale/missing keepalive value is named; the fix line is the tunnel's", () => {
    attach({
      good: "http://127.0.0.1:45001",
      stale: "http://127.0.0.1:45002",
      "no-tcp": "http://127.0.0.1:45003",
      "wrong-port": "http://127.0.0.1:45004",
    });
    placeAgent(managedFile("good"), rendered("good", 45001));
    placeAgent(managedFile("stale"), rendered("stale", 45002).replace("ServerAliveInterval=15", "ServerAliveInterval=30").replace("ServerAliveCountMax=2", "ServerAliveCountMax=3"));
    placeAgent(managedFile("no-tcp"), rendered("no-tcp", 45003).replace("<string>-o</string>\n\t\t<string>TCPKeepAlive=yes</string>\n", "").replace("<string>-o</string>\n\t\t<string>ExitOnForwardFailure=yes</string>\n", ""));
    placeAgent(managedFile("wrong-port"), rendered("wrong-port", 45999));
    const byName = Object.fromEntries(run().map((c) => [c.name, c]));
    expect(Object.keys(byName).sort()).toEqual([
      "Fleet peer forward (good)", "Fleet peer forward (no-tcp)", "Fleet peer forward (stale)", "Fleet peer forward (wrong-port)",
    ]);
    expect(byName["Fleet peer forward (good)"].ok).toBe(true);

    const stale = byName["Fleet peer forward (stale)"];
    expect(stale.ok).toBe(false);
    expect(stale.detail).toMatch(/ServerAliveInterval is 30 \(stale, should be 15\)/);
    expect(stale.detail).toMatch(/ServerAliveCountMax is 3 \(stale, should be 2\)/);
    expect(stale.fix).toBe("bash tools/fleet/install.sh  (Fleet — Repair regenerates it: 15/2 + TCPKeepAlive)");

    const noTcp = byName["Fleet peer forward (no-tcp)"];
    expect(noTcp.ok).toBe(false);
    expect(noTcp.detail).toMatch(/TCPKeepAlive yes missing/);
    expect(noTcp.detail).toMatch(/ExitOnForwardFailure yes missing/);

    const wrongPort = byName["Fleet peer forward (wrong-port)"];
    expect(wrongPort.ok).toBe(false);
    expect(wrongPort.detail).toMatch(/LocalForward 127\.0\.0\.1:45004:127\.0\.0\.1:4096 missing/);
  });

  it("a hand-installed legacy forward is enumerated by label convention and its stale 30/3 flagged — the fix names the backup-keeping replace", () => {
    attach({ "jjs-mac-studio": "http://127.0.0.1:45096" });
    // The real hand-installed shape: 30/3, no TCPKeepAlive, unbound -L.
    placeAgent("co.harmoniqs.amico-studio-forward.plist", `<plist><dict><key>Label</key><string>co.harmoniqs.amico-studio-forward</string>
<key>ProgramArguments</key><array><string>/usr/bin/ssh</string><string>-N</string><string>-L</string><string>45096:127.0.0.1:4096</string>
<string>-o</string><string>ExitOnForwardFailure=yes</string><string>-o</string><string>ServerAliveInterval=30</string>
<string>-o</string><string>ServerAliveCountMax=3</string><string>jjs-mac-studio</string></array></dict></plist>`);
    placeAgent("co.harmoniqs.amico-tunnel.plist", "not a forward agent — the hub tunnel has its own check");
    const byName = Object.fromEntries(run().map((c) => [c.name, c]));
    expect(Object.keys(byName).sort()).toEqual([
      "Fleet peer forward (hand-installed co.harmoniqs.amico-studio-forward)",
      "Fleet peer forward (jjs-mac-studio)",
    ]);
    const legacy = byName["Fleet peer forward (hand-installed co.harmoniqs.amico-studio-forward)"];
    expect(legacy.ok).toBe(false);
    expect(legacy.detail).toMatch(/ServerAliveInterval is 30 \(stale, should be 15\)/);
    expect(legacy.detail).toMatch(/ServerAliveCountMax is 3 \(stale, should be 2\)/);
    expect(legacy.detail).toMatch(/TCPKeepAlive yes missing/);
    expect(legacy.fix).toMatch(/bash tools\/fleet\/install\.sh .*replaces it .*backup/);
    expect(byName["Fleet peer forward (jjs-mac-studio)"].ok).toBe(false); // the managed agent is not there yet
  });

  it("a peer reached over https (tailscale/direct) needs no forward — no check; no attached peers and no agents → no checks", () => {
    attach({ far: "https://far.tailnet-1234.ts.net" });
    expect(run()).toEqual([]);
  });

  it("skips off darwin — launchd agents only (the supervised linux/WSL link is #1260)", () => {
    attach({ "jjs-mac-studio": "http://127.0.0.1:45096" });
    expect(checkPeerForwards({ launchAgentsDir, peerStoreFile, platform: "linux", topology: okServer })).toEqual([]);
  });

  it("the aggregate report carries the peer forward checks on EVERY role (a peer may be server, standalone, or client); a broken projection still surfaces only the role fail", () => {
    attach({ "jjs-mac-studio": "http://127.0.0.1:45096" });
    const base = {
      repoGuardPath: REPO,
      configuredBinary: INSTALLED,
      configuredPort: 4096,
      plistContent: `ServerAliveInterval=15 ServerAliveCountMax=2 TCPKeepAlive=yes 127.0.0.1:4096:127.0.0.1:4096`,
      read: () => guardContent,
      isExecutable: () => true,
      platform: "darwin",
      launchAgentsDir,
      peerStoreFile,
    };
    for (const [topology, n] of [[okServer, 2], [okStandalone, 2], [absent, 2], [okClient, 5]] as const) {
      const r = fleetHealthReport({ ...base, topology });
      expect(r, `role ${topology.kind}`).toHaveLength(n);
      const peer = r.find((c) => c.name === "Fleet peer forward (jjs-mac-studio)");
      expect(peer?.ok).toBe(false);
      expect(peer?.fix).toMatch(/install\.sh/);
    }
    expect(fleetHealthReport({ ...base, topology: broken })).toHaveLength(1);
  });
});
