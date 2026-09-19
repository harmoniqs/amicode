// fleet_hub_service.test.ts — #1258 (Durable hub — reboot-survival for the
// canonical hub). The canonical hub must survive a REBOOT with NO editor ever
// opened. Today the hub is the extension-spawned detached server (ADR 0020) —
// it survives a window close but DIES ON REBOOT. The corrected design (this
// issue) runs the EXISTING #955 headless runner (amicode_service_runner_cli.ts,
// bundled to bin/dist/amicode-service-runner.mjs) under launchd (macOS) /
// systemd (Linux) with RunAtLoad + KeepAlive — NOT a bespoke `opencode serve`
// wrapper (the WITHDRAWN design: reclaim-killed by the editor's adoptOrSpawn,
// and two writers on one SQLite DB is the failure the review found).
//
// This file pins the two pure-function unit renderers (the launchd plist + the
// systemd unit). Both:
//   - persist across reboot + auto-restart (RunAtLoad/KeepAlive ≙ WantedBy/Restart),
//   - exec the #955 RUNNER (node → amicode-service-runner.mjs), NEVER `opencode serve`,
//   - pin the canonical OPENCODE_DB — the ONE-writer store (ADR 0005),
//   - are DISTINCT from #1260's tunnel unit (which runs `ssh -L`, a different concern).
import { describe, it, expect } from "vitest";
import {
  launchdHubServiceUnit,
  systemdHubServiceUnit,
  hubServiceProgramArgs,
  HUB_SERVICE_LABEL,
  type HubServiceUnitOptions,
} from "../src/amicode_service/fleet_hub_service";
import { systemdTunnelUnit } from "../src/amicode_service/fleet_transport";

/** The canonical hub deployment shape the installer resolves and bakes in:
 *  an absolute node, the bundled #955 runner, the built app-bundle dist root
 *  (AMICODE_APP_DIST), the canonical fleet port, and the ONE-writer DB pin. */
const OPTS: HubServiceUnitOptions = {
  nodeBin: "/usr/local/bin/node",
  runnerPath: "/opt/amico/ext/bin/dist/amicode-service-runner.mjs",
  appDist: "/opt/amico/ext/dist/app",
  servicePort: 4096,
  dbPath: "/home/hub/.amico/server/session.db",
  logPath: "/tmp/amico-hub.log",
};

describe("#1258 launchdHubServiceUnit — the macOS reboot-survival form (RunAtLoad + KeepAlive)", () => {
  it("boots at load AND stays up: RunAtLoad=true + KeepAlive=true (the reboot-survival + auto-restart behavior)", () => {
    const plist = launchdHubServiceUnit(OPTS);
    // RunAtLoad → the service comes up on boot even with no editor ever opened.
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    // KeepAlive → launchd restarts it if it dies (the "stays up" half).
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });

  it("runs the #955 RUNNER (node → amicode-service-runner.mjs), NEVER a bespoke `opencode serve`", () => {
    const plist = launchdHubServiceUnit(OPTS);
    expect(plist).toContain("<key>ProgramArguments</key>");
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).toContain("<string>/opt/amico/ext/bin/dist/amicode-service-runner.mjs</string>");
    // the withdrawn design — a bespoke serve wrapper — must never be the program
    expect(plist).not.toContain("opencode serve");
    expect(plist).not.toMatch(/<string>serve<\/string>/);
  });

  it("pins the canonical OPENCODE_DB — the ONE writer's store (ADR 0005), plus the runner's required env", () => {
    const plist = launchdHubServiceUnit(OPTS);
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    // one canonical DB / one writer: the unit pins the store the editor adopts.
    expect(plist).toContain("<key>OPENCODE_DB</key>");
    expect(plist).toContain("<string>/home/hub/.amico/server/session.db</string>");
    // the runner REQUIRES AMICODE_APP_DIST or it fails loud at boot (#955 contract)
    expect(plist).toContain("<key>AMICODE_APP_DIST</key>");
    expect(plist).toContain("<string>/opt/amico/ext/dist/app</string>");
    // it serves on the canonical fleet port the tunnel/clients target
    expect(plist).toContain("<key>AMICODE_SERVICE_PORT</key>");
    expect(plist).toContain("<string>4096</string>");
  });

  it("carries a stable Label + log redirection (a well-formed launchd agent)", () => {
    const plist = launchdHubServiceUnit(OPTS);
    expect(plist).toContain("<key>Label</key>");
    expect(plist).toContain(`<string>${HUB_SERVICE_LABEL}</string>`);
    expect(plist).toContain("<key>StandardOutPath</key>");
    expect(plist).toContain("<key>StandardErrorPath</key>");
    expect(plist).toContain("<string>/tmp/amico-hub.log</string>");
    // a well-formed plist wrapper (the installer writes this verbatim)
    expect(plist).toContain("<!DOCTYPE plist");
    expect(plist.trimStart().startsWith("<?xml")).toBe(true);
  });
});

describe("#1258 systemdHubServiceUnit — the Linux reboot-survival form (WantedBy + Restart=always)", () => {
  it("boots at load AND stays up: [Install] WantedBy (enable → start at boot) + Restart=always (the KeepAlive equivalent)", () => {
    const unit = systemdHubServiceUnit(OPTS);
    expect(unit).toContain("[Install]");
    expect(unit).toMatch(/WantedBy=/); // `systemctl --user enable` → starts at boot (RunAtLoad ≙)
    expect(unit).toContain("Restart=always"); // launchd KeepAlive ≙ systemd Restart=always
  });

  it("ExecStart runs the #955 RUNNER (node → amicode-service-runner.mjs), NEVER a bespoke `opencode serve`", () => {
    const unit = systemdHubServiceUnit(OPTS);
    expect(unit).toContain("[Service]");
    expect(unit).toMatch(/ExecStart=\/usr\/local\/bin\/node .*amicode-service-runner\.mjs/);
    expect(unit).not.toContain("opencode serve");
  });

  it("pins the canonical OPENCODE_DB + the runner's required env via Environment= lines", () => {
    const unit = systemdHubServiceUnit(OPTS);
    expect(unit).toContain("Environment=OPENCODE_DB=/home/hub/.amico/server/session.db");
    expect(unit).toContain("Environment=AMICODE_APP_DIST=/opt/amico/ext/dist/app");
    expect(unit).toContain("Environment=AMICODE_SERVICE_PORT=4096");
  });
});

describe("#1258 the hub-service unit is DISTINCT from #1260's tunnel unit (not conflated)", () => {
  it("the hub-service systemd unit runs the RUNNER; the tunnel unit runs `ssh -L` — they are different services", () => {
    const hub = systemdHubServiceUnit(OPTS);
    const tunnel = systemdTunnelUnit({ alias: "fleet-hub", port: 4096 });
    // the hub SERVICE execs node → the runner…
    expect(hub).toMatch(/ExecStart=.*amicode-service-runner\.mjs/);
    expect(hub).not.toContain("/usr/bin/ssh");
    // …the TUNNEL execs ssh -L (the transport, #1260) — a different concern.
    expect(tunnel).toContain("/usr/bin/ssh");
    expect(tunnel).not.toContain("amicode-service-runner.mjs");
    // and they are not byte-identical (the two are not the same unit)
    expect(hub).not.toBe(tunnel);
  });

  it("hubServiceProgramArgs is the shared argv both OS forms exec — node then the runner (the ONE-writer program)", () => {
    const args = hubServiceProgramArgs(OPTS);
    expect(args[0]).toBe("/usr/local/bin/node");
    expect(args[args.length - 1]).toBe("/opt/amico/ext/bin/dist/amicode-service-runner.mjs");
    // the launchd + systemd forms both exec exactly this argv (no divergence)
    for (const a of args) expect(launchdHubServiceUnit(OPTS)).toContain(a);
    expect(systemdHubServiceUnit(OPTS)).toContain(args.join(" "));
  });
});
