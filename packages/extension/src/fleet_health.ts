// Fleet health — pure, testable checks that prevent the 2026-08-07 / 2026-08-09
// silent-fork regressions (ADR 0005, #279, #324, #338) from recurring.
//
// Every check is synchronous + injectable (no direct fs/exec) so it is
// unit-testable and never blocks activation. The extension's `amicode.healthcheck`
// and activation warning call these; `tools/fleet/install.sh --check` is the CLI twin.
//
// Fleet role is determined by ~/.amico/ops/fleet/fleet.json (no file = standalone).
// A fleet client must NEVER spawn a local opencode server. The guard
// `tools/fleet/amico-opencode-fleet-guard` enforces it by reading fleet.json and
// `exit 1` when role = "client".

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { readFleetConfig, type FleetConfig } from "./fleet_fallback";

export const FLEET_GUARD_REL = "tools/fleet/amico-opencode-fleet-guard";
export const FLEET_GUARD_INSTALL = path.join(homedir(), ".local", "bin", "amico-opencode-fleet-guard");

export type FleetCheck = { name: string; ok: boolean; detail: string; fix?: string };

function readOrNull(p: string, read: (p: string) => string): string | null {
  try {
    return read(p);
  } catch {
    return null;
  }
}

/** Guard check: repo guard exists, installed guard exists + matches repo (byte-identical) + executable. */
export function checkFleetGuard(
  repoGuardPath: string,
  installedGuardPath: string = FLEET_GUARD_INSTALL,
  opts: { read?: (p: string) => string; isExecutable?: (p: string) => boolean; platform?: string } = {},
): FleetCheck {
  const read = opts.read ?? ((p: string) => fs.readFileSync(p, "utf8"));
  // Fleet guard only matters on darwin; elsewhere it's a no-op.
  if ((opts.platform ?? process.platform) !== "darwin") {
    return { name: "Fleet guard", ok: true, detail: "skipped (not darwin)" };
  }
  const repo = readOrNull(repoGuardPath, read);
  if (repo == null) return { name: "Fleet guard", ok: false, detail: `repo guard missing at ${repoGuardPath}`, fix: "git pull (fleet hardening not merged)" };
  const installed = readOrNull(installedGuardPath, read);
  if (installed == null) {
    return {
      name: "Fleet guard",
      ok: false,
      detail: `not installed at ${installedGuardPath}`,
      fix: `bash ${FLEET_GUARD_REL.replace("tools/fleet/amico-opencode-fleet-guard", "tools/fleet/install.sh")}  (or cp ${FLEET_GUARD_REL} ${installedGuardPath})`,
    };
  }
  if (installed !== repo) {
    return {
      name: "Fleet guard",
      ok: false,
      detail: "installed guard is stale (differs from repo)",
      fix: `bash tools/fleet/install.sh  (or cp ${FLEET_GUARD_REL} ${installedGuardPath})`,
    };
  }
  const isExec = opts.isExecutable ?? ((p: string) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
  if (!isExec(installedGuardPath)) {
    return { name: "Fleet guard", ok: false, detail: `not executable: ${installedGuardPath}`, fix: `chmod +x ${installedGuardPath}` };
  }
  return { name: "Fleet guard", ok: true, detail: `installed and in sync (${installedGuardPath})` };
}

/** Settings check: amicode.opencodeBinary must point at the guard and opencodePort must match fleet config. */
export function checkFleetSettings(
  configuredBinary: string,
  configuredPort: number,
  opts: { platform?: string; fleetConfig?: FleetConfig | null } = {},
): FleetCheck {
  if ((opts.platform ?? process.platform) !== "darwin") {
    return { name: "Fleet settings", ok: true, detail: "skipped (not darwin)" };
  }
  const cfg = opts.fleetConfig ?? readFleetConfig();
  const wantPort = cfg?.canonical?.port ?? 4096;
  const wantBinary = FLEET_GUARD_INSTALL;
  // Empty binary = vendored default → on a fleet client this would spawn a fork, so flag it.
  if (!configuredBinary || configuredBinary.trim() === "") {
    return {
      name: "Fleet settings",
      ok: false,
      detail: `amicode.opencodeBinary not set (would spawn vendored binary, not the guard)`,
      fix: `set amicode.opencodeBinary to ${wantBinary} (scope: machine)`,
    };
  }
  const normalized = configuredBinary.trim();
  // Allow the guard path with or without $HOME expansion; require suffix match.
  const isGuard = normalized === wantBinary || normalized.endsWith("/amico-opencode-fleet-guard");
  if (!isGuard) {
    return {
      name: "Fleet settings",
      ok: false,
      detail: `amicode.opencodeBinary points at ${normalized}, not the fleet guard`,
      fix: `set amicode.opencodeBinary to ${wantBinary} (scope: machine)`,
    };
  }
  if (configuredPort !== wantPort) {
    return {
      name: "Fleet settings",
      ok: false,
      detail: `amicode.opencodePort is ${configuredPort}, expected ${wantPort} (tunnel port)`,
      fix: `set amicode.opencodePort to ${wantPort} (scope: machine)`,
    };
  }
  return { name: "Fleet settings", ok: true, detail: `guard + port ${wantPort} (machine scope)` };
}

/** Tunnel plist check: ServerAliveInterval 15, CountMax 2, TCPKeepAlive yes, correct port forward. */
export function checkFleetTunnel(
  plistContent: string | null,
  opts: { platform?: string; fleetConfig?: FleetConfig | null } = {},
): FleetCheck {
  if ((opts.platform ?? process.platform) !== "darwin") {
    return { name: "Fleet tunnel", ok: true, detail: "skipped (not darwin)" };
  }
  if (plistContent == null) {
    return {
      name: "Fleet tunnel",
      ok: false,
      detail: "launchd tunnel plist missing (~/Library/LaunchAgents/co.harmoniqs.amico-tunnel.plist)",
      fix: "bash tools/fleet/install.sh  (installs tunnel plist)",
    };
  }
  const cfg = opts.fleetConfig ?? readFleetConfig();
  const port = cfg?.canonical?.port ?? 4096;
  const portForward = `127.0.0.1:${port}:127.0.0.1:${port}`;

  const issues: string[] = [];
  // Check ServerAliveInterval
  if (!plistContent.includes("ServerAliveInterval=15") && !plistContent.includes("ServerAliveInterval")) {
    issues.push("ServerAliveInterval 15 missing");
  } else if (plistContent.includes("ServerAliveInterval=30")) {
    issues.push("ServerAliveInterval is 30 (stale, should be 15)");
  }
  if (!plistContent.includes("ServerAliveCountMax=2") && !plistContent.includes("ServerAliveCountMax")) {
    issues.push("ServerAliveCountMax 2 missing");
  } else if (plistContent.includes("ServerAliveCountMax=3")) {
    issues.push("ServerAliveCountMax is 3 (stale, should be 2)");
  }
  if (!plistContent.includes("TCPKeepAlive=yes")) issues.push("TCPKeepAlive yes missing");
  if (!plistContent.includes(portForward)) issues.push(`LocalForward ${portForward} missing`);

  // Deduplicate and decide
  const uniq = [...new Set(issues)];
  if (uniq.length > 0) {
    return { name: "Fleet tunnel", ok: false, detail: uniq.join("; "), fix: "bash tools/fleet/install.sh  (tunes tunnel to 15/2 + TCPKeepAlive)" };
  }
  return { name: "Fleet tunnel", ok: true, detail: `ServerAlive 15/2 + TCPKeepAlive, ${port} forward` };
}

/** Fleet role check — surfaces the current mode. */
export function checkFleetRole(
  opts: { read?: (p: string) => string; platform?: string } = {},
): FleetCheck {
  if ((opts.platform ?? process.platform) !== "darwin") {
    return { name: "Fleet role", ok: true, detail: "skipped (not darwin)" };
  }
  const cfg = readFleetConfig(undefined, opts.read);
  const role = cfg?.role ?? "standalone";
  if (role === "standalone") {
    return { name: "Fleet role", ok: true, detail: "standalone (local server, no fleet)" };
  }
  if (role === "server") {
    return { name: "Fleet role", ok: true, detail: `server (canonical for fleet, host: ${cfg?.canonical?.host ?? "unknown"})` };
  }
  if (role === "client") {
    return { name: "Fleet role", ok: true, detail: `client → ${cfg?.canonical?.host ?? "unknown"}:${cfg?.canonical?.port ?? 4096} via ${cfg?.canonical?.sshAlias ?? "ssh"}` };
  }
  return { name: "Fleet role", ok: false, detail: `unknown role: ${role}`, fix: "check ~/.amico/ops/fleet/fleet.json" };
}

/** Aggregate helper — returns all fleet checks (role + guard + settings + tunnel).
 *  When role is standalone, guard/settings/tunnel checks are skipped (not relevant). */
export function fleetHealthReport(args: {
  repoGuardPath: string;
  installedGuardPath?: string;
  configuredBinary: string;
  configuredPort: number;
  plistContent: string | null;
  read?: (p: string) => string;
  isExecutable?: (p: string) => boolean;
  platform?: string;
}): FleetCheck[] {
  const cfg = readFleetConfig(undefined, args.read);
  const role = cfg?.role ?? "standalone";

  // Standalone: fleet checks are irrelevant — just surface the role.
  if (role === "standalone" && (args.platform ?? process.platform) === "darwin") {
    return [
      checkFleetRole({ read: args.read, platform: args.platform }),
    ];
  }

  return [
    checkFleetRole({ read: args.read, platform: args.platform }),
    checkFleetGuard(args.repoGuardPath, args.installedGuardPath, { read: args.read, isExecutable: args.isExecutable, platform: args.platform }),
    checkFleetSettings(args.configuredBinary, args.configuredPort, { platform: args.platform, fleetConfig: cfg }),
    checkFleetTunnel(args.plistContent, { platform: args.platform, fleetConfig: cfg }),
  ];
}
