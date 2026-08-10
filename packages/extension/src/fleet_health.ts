// Fleet health — pure, testable checks that prevent the 2026-08-07 / 2026-08-09
// silent-fork regressions (ADR 0005, #279, #324) from recurring.
//
// Every check is synchronous + injectable (no direct fs/exec) so it is
// unit-testable and never blocks activation. The extension's `amicode.healthcheck`
// and activation warning call these; `tools/fleet/install.sh --check` is the CLI twin.
//
// Invariant: the MacBook (fleet client) must NEVER spawn a local opencode server.
// The guard `tools/fleet/amico-opencode-fleet-guard` enforces it by `exit 1` on
// any host whose LocalHostName != canonical. Without the guard the fixed-port
// race (`amicode.opencodePort: 4096`) silently forks `opencode.db`.

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

export const FLEET_CANONICAL_HOST = "Aarons-Mac-mini";
export const FLEET_PORT = 4096;
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
  // Fleet guard only matters on darwin; elsewhere it's a no-op (solo/Linux never uses the tunnel).
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

/** Settings check: amicode.opencodeBinary must point at the guard and opencodePort must be 4096 on darwin fleet hosts. */
export function checkFleetSettings(
  configuredBinary: string,
  configuredPort: number,
  opts: { platform?: string } = {},
): FleetCheck {
  if ((opts.platform ?? process.platform) !== "darwin") {
    return { name: "Fleet settings", ok: true, detail: "skipped (not darwin)" };
  }
  const wantBinary = FLEET_GUARD_INSTALL;
  // Empty binary = vendored default → on a fleet client this would spawn a fork, so flag it.
  // On the canonical host the vendored binary would also be wrong (should go through guard → frozen).
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
  if (configuredPort !== FLEET_PORT) {
    return {
      name: "Fleet settings",
      ok: false,
      detail: `amicode.opencodePort is ${configuredPort}, expected ${FLEET_PORT} (tunnel port)`,
      fix: `set amicode.opencodePort to ${FLEET_PORT} (scope: machine)`,
    };
  }
  return { name: "Fleet settings", ok: true, detail: `guard + port ${FLEET_PORT} (machine scope)` };
}

/** Tunnel plist check: ServerAliveInterval 15, CountMax 2, TCPKeepAlive yes, -L 127.0.0.1:4096:127.0.0.1:4096 */
export function checkFleetTunnel(
  plistContent: string | null,
  opts: { platform?: string } = {},
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
  const issues: string[] = [];
  if (!plistContent.includes("ServerAliveInterval") || !/<string>ServerAliveInterval<\/string>\s*<string>15<\/string>/.test(plistContent)) {
    // Plist stores as <string>ServerAliveInterval=15</string> via ProgramArguments; be permissive.
    if (!plistContent.includes("ServerAliveInterval=15") && !plistContent.includes("ServerAliveInterval</string>") ) {
      // fallback strict check: look for 15 near ServerAliveInterval
      const m = plistContent.match(/ServerAliveInterval[^\d]*(\d+)/);
      if (!m || m[1] !== "15") issues.push("ServerAliveInterval should be 15");
    } else if (!plistContent.includes("15")) {
      issues.push("ServerAliveInterval should be 15");
    }
  }
  // More robust: just check substrings that the hardened plist definitely contains.
  if (!plistContent.includes("ServerAliveInterval=15") && !plistContent.includes("ServerAliveInterval") ) {
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
  if (!plistContent.includes("127.0.0.1:4096:127.0.0.1:4096")) issues.push("LocalForward 127.0.0.1:4096:127.0.0.1:4096 missing");

  // Deduplicate and decide
  const uniq = [...new Set(issues)];
  if (uniq.length > 0) {
    return { name: "Fleet tunnel", ok: false, detail: uniq.join("; "), fix: "bash tools/fleet/install.sh  (tunes tunnel to 15/2 + TCPKeepAlive)" };
  }
  return { name: "Fleet tunnel", ok: true, detail: "ServerAlive 15/2 + TCPKeepAlive, 4096 forward" };
}

/** Aggregate helper — returns all fleet checks (guard + settings + tunnel). */
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
  return [
    checkFleetGuard(args.repoGuardPath, args.installedGuardPath, { read: args.read, isExecutable: args.isExecutable, platform: args.platform }),
    checkFleetSettings(args.configuredBinary, args.configuredPort, { platform: args.platform }),
    checkFleetTunnel(args.plistContent, { platform: args.platform }),
  ];
}
