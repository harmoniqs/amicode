// Fleet health — pure, testable checks that prevent the 2026-08-07 / 2026-08-09
// silent-fork regressions (ADR 0005, #279, #324, #338) from recurring.
//
// Every check is synchronous + injectable (no direct fs/exec beyond the
// injectable defaults) so it is unit-testable and never blocks activation. The
// extension's `amicode.healthcheck` and activation warning call these;
// `tools/fleet/install.sh --check` is the CLI twin.
//
// #1106 (fleet rearchitect P3b-2): fleet role + canonical port come from the
// projection-cache topology state (fleet_topology.ts — @amicode/schema's
// reader over ~/.amico/ops/fleet/projection.json), NEVER the raw fleet.json.
// Absent projection renders the base-default standalone WITH the refresh
// pointer; a broken projection is a RENDERED fail state carrying the reader's
// rejection + the refresh fix — neither is ever a silent raw-file fallthrough.
// A fleet client must NEVER spawn a local opencode server; the guard
// `tools/fleet/amico-opencode-fleet-guard` enforces it by reading the
// projection cache and `exit 1` when role = "client".

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { readFleetTopology, type FleetTopologyState } from "./fleet_topology";
import { listPeerBaseUrls } from "./amicode_service/fleet_peer_store";

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
  // #1261 (AC4): the guard backstop is cross-platform — a client spawns no
  // engine on mac, linux, OR WSL, so this check RUNS everywhere (only the
  // launchd-plist tunnel check below stays darwin-specific, deferring to #1260).
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

/** The canonical port the settings/tunnel checks compare against — from the
 *  projection topology (base default 4096 when the topology carries none). */
function fleetPort(topology: FleetTopologyState | undefined): number {
  if (topology === undefined || topology.kind !== "ok") return 4096;
  return topology.canonical?.port ?? 4096;
}

/** Settings check: amicode.opencodeBinary must point at the guard and opencodePort must match the projection's canonical port. */
export function checkFleetSettings(
  configuredBinary: string,
  configuredPort: number,
  opts: { platform?: string; topology?: FleetTopologyState } = {},
): FleetCheck {
  // #1261 (AC4): the guard/port settings must be correct on every platform a
  // client runs on (mac, linux, WSL) — this check RUNS cross-platform.
  const topology = opts.topology ?? readFleetTopology();
  const wantPort = fleetPort(topology);
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
  opts: { platform?: string; topology?: FleetTopologyState } = {},
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
  const topology = opts.topology ?? readFleetTopology();
  const port = fleetPort(topology);
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

// ── #1775: per-peer SSH forward agents ─────────────────────────────────────────
// The installer generates one launchd agent per attached peer (tools/fleet/
// co.harmoniqs.amico-peer-forward.plist); this check enumerates every forward
// agent in the LaunchAgents dir BY LABEL CONVENTION and holds each to the hub
// tunnel's keepalive standard. The attached peers come from the reader
// peer-token store: a loopback base_url's port IS the forward's local end.

/** The managed per-peer forward label — deterministic from the peer's machine id. */
export function peerForwardLabel(machineId: string): string {
  return `co.harmoniqs.amico-peer-${machineId}-forward`;
}

/** Any `co.harmoniqs.amico-<name>-forward` agent file — managed or hand-installed. */
const FORWARD_AGENT_FILE = /^co\.harmoniqs\.amico-(.+)-forward\.plist$/;
/** The managed shape inside it: `co.harmoniqs.amico-peer-<machine_id>-forward`. */
const MANAGED_FORWARD_FILE = /^co\.harmoniqs\.amico-peer-(.+)-forward\.plist$/;

/** A peer's ssh-forwarded local port: only a loopback http base URL with an
 *  explicit port rides an SSH forward (https = tailscale/direct reach → none). */
function loopbackForwardPort(baseUrl: string): number | null {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" || (u.hostname !== "127.0.0.1" && u.hostname !== "localhost")) return null;
  const port = Number(u.port);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** The keepalive standard (fleet_transport sshForwardArgs), value-exact. */
function forwardKeepaliveIssues(content: string): string[] {
  const issues: string[] = [];
  const interval = /ServerAliveInterval=(\d+)/.exec(content)?.[1];
  if (interval === undefined) issues.push("ServerAliveInterval 15 missing");
  else if (interval !== "15") issues.push(`ServerAliveInterval is ${interval} (stale, should be 15)`);
  const count = /ServerAliveCountMax=(\d+)/.exec(content)?.[1];
  if (count === undefined) issues.push("ServerAliveCountMax 2 missing");
  else if (count !== "2") issues.push(`ServerAliveCountMax is ${count} (stale, should be 2)`);
  if (!content.includes("TCPKeepAlive=yes")) issues.push("TCPKeepAlive yes missing");
  if (!content.includes("ExitOnForwardFailure=yes")) issues.push("ExitOnForwardFailure yes missing");
  return issues;
}

const PEER_FORWARD_REGENERATE = "bash tools/fleet/install.sh  (Fleet — Repair regenerates it: 15/2 + TCPKeepAlive)";
const PEER_FORWARD_REPLACE = "bash tools/fleet/install.sh  (Fleet — Repair replaces it with the managed agent and keeps a backup)";

/** Per-peer forward check: one FleetCheck per attached loopback peer (its
 *  managed agent present, 15/2 + TCPKeepAlive + ExitOnForwardFailure, the
 *  `127.0.0.1:<local>:127.0.0.1:<fleet port>` forward) plus one per OTHER
 *  forward agent found by label convention (a hand-installed legacy agent, or
 *  a managed agent for a peer no longer attached). darwin only; [] when there
 *  is nothing to report. */
export function checkPeerForwards(opts: {
  launchAgentsDir: string;
  /** The reader peer-token store (default: fleet_peer_store's resolution). */
  peerStoreFile?: string;
  platform?: string;
  topology?: FleetTopologyState;
  listDir?: (dir: string) => string[];
  read?: (p: string) => string;
}): FleetCheck[] {
  if ((opts.platform ?? process.platform) !== "darwin") return [];
  const read = opts.read ?? ((p: string) => fs.readFileSync(p, "utf8"));
  const listDir = opts.listDir ?? ((d: string) => fs.readdirSync(d));
  let files: string[] = [];
  try {
    files = listDir(opts.launchAgentsDir).filter((f) => FORWARD_AGENT_FILE.test(f)).sort();
  } catch {
    files = [];
  }
  const attached = listPeerBaseUrls({ storeFile: opts.peerStoreFile })
    .map((p) => ({ machineId: p.machineId, port: loopbackForwardPort(p.baseUrl) }))
    .filter((p): p is { machineId: string; port: number } => p.port !== null);
  const remotePort = fleetPort(opts.topology ?? readFleetTopology());

  const checks: FleetCheck[] = [];
  const claimed = new Set<string>();
  for (const peer of attached) {
    const label = peerForwardLabel(peer.machineId);
    const file = `${label}.plist`;
    claimed.add(file);
    const name = `Fleet peer forward (${peer.machineId})`;
    const portForward = `127.0.0.1:${peer.port}:127.0.0.1:${remotePort}`;
    const content = files.includes(file) ? readOrNull(path.join(opts.launchAgentsDir, file), read) : null;
    if (content == null) {
      checks.push({
        name,
        ok: false,
        detail: `launchd forward agent missing (${path.join(opts.launchAgentsDir, file)})`,
        fix: "bash tools/fleet/install.sh  (Fleet — Repair generates it)",
      });
      continue;
    }
    const issues = forwardKeepaliveIssues(content);
    if (!content.includes(portForward)) issues.push(`LocalForward ${portForward} missing`);
    checks.push(
      issues.length > 0
        ? { name, ok: false, detail: issues.join("; "), fix: PEER_FORWARD_REGENERATE }
        : { name, ok: true, detail: `ServerAlive 15/2 + TCPKeepAlive, ${portForward} forward` },
    );
  }

  for (const file of files) {
    if (claimed.has(file)) continue;
    const content = readOrNull(path.join(opts.launchAgentsDir, file), read) ?? "";
    const issues = forwardKeepaliveIssues(content);
    const managed = MANAGED_FORWARD_FILE.exec(file);
    if (managed !== null) {
      // A managed agent whose peer is no longer in the token store.
      const name = `Fleet peer forward (${managed[1]})`;
      const note = "no attached peer in the token store";
      checks.push(
        issues.length > 0
          ? { name, ok: false, detail: `${issues.join("; ")} (${note})`, fix: PEER_FORWARD_REGENERATE }
          : { name, ok: true, detail: `ServerAlive 15/2 + TCPKeepAlive (${note})` },
      );
      continue;
    }
    // A hand-installed `co.harmoniqs.amico-<name>-forward`. It belongs to an
    // attached peer when it binds that peer's local port or names its machine
    // id as the ssh destination — the installer replaces exactly those.
    const label = file.replace(/\.plist$/, "");
    const name = `Fleet peer forward (hand-installed ${label})`;
    const owner = attached.find(
      (p) => new RegExp(`<string>((127\\.0\\.0\\.1|localhost):)?${p.port}:`).test(content) || content.includes(`<string>${p.machineId}</string>`),
    );
    if (owner !== undefined) {
      checks.push({
        name,
        ok: false,
        detail: `hand-installed forward for peer ${owner.machineId}, not managed by the installer${issues.length > 0 ? ` — ${issues.join("; ")}` : ""}`,
        fix: PEER_FORWARD_REPLACE,
      });
    } else if (issues.length > 0) {
      checks.push({
        name,
        ok: false,
        detail: `${issues.join("; ")} (no attached peer matches it, so the installer leaves it alone)`,
        fix: `retune it to 15/2 + TCPKeepAlive, or attach its peer and run bash tools/fleet/install.sh  (Fleet — Repair then replaces it and keeps a backup)`,
      });
    } else {
      checks.push({ name, ok: true, detail: "ServerAlive 15/2 + TCPKeepAlive (hand-installed; no attached peer matches it)" });
    }
  }
  return checks;
}

/** Fleet role check — surfaces the current mode from the projection topology.
 *  Every state renders honestly (#1106): ok → the role + canonical target +
 *  the D1 freshness verdict when present; absent → the base-default
 *  standalone WITH the refresh pointer; broken → a rendered fail carrying
 *  the reader's rejection + the refresh fix. */
export function checkFleetRole(
  opts: { topology?: FleetTopologyState; platform?: string } = {},
): FleetCheck {
  // #1261 (AC4): the role surfaces on every platform (the projection read is
  // OS-neutral) — a linux/WSL client must see its client role, not a skip.
  const topology = opts.topology ?? readFleetTopology();

  if (topology.kind === "absent") {
    return {
      name: "Fleet role",
      ok: true,
      detail: `standalone (no fleet projection — base default; ${topology.detail})`,
    };
  }
  if (topology.kind === "broken") {
    return {
      name: "Fleet role",
      ok: false,
      detail: topology.detail,
      fix: "refresh the projection: `amico fleet status --projection` (the CLI is the only door)",
    };
  }
  const role = topology.role;
  const freshness = topology.verdict === undefined
    ? ""
    : ` — freshness: ${topology.verdict}${topology.advisory === undefined ? "" : ` (${topology.advisory})`}`;
  if (role === "standalone") {
    return { name: "Fleet role", ok: true, detail: `standalone (local server, no fleet)${freshness}` };
  }
  if (role === "server") {
    return { name: "Fleet role", ok: true, detail: `server (canonical for fleet, host: ${topology.canonical?.host ?? "unknown"})${freshness}` };
  }
  if (role === "client") {
    return {
      name: "Fleet role",
      ok: true,
      detail: `client → ${topology.canonical?.host ?? "unknown"}:${topology.canonical?.port ?? 4096} via ${topology.canonical?.sshAlias ?? "ssh"}${freshness}`,
    };
  }
  return { name: "Fleet role", ok: false, detail: `unknown role: ${role}`, fix: "refresh the projection: `amico fleet status --projection`" };
}

/** Aggregate helper — returns all fleet checks (role + guard + settings + tunnel
 *  + per-peer forwards).
 *  When role is standalone (or the projection is absent — the same base
 *  default), guard/settings/tunnel checks are skipped (not relevant); a
 *  broken projection surfaces ONLY the role check's rendered fail. The
 *  per-peer forward checks (#1775) run on EVERY role — a peer may be
 *  standalone, server, or client — whenever a LaunchAgents dir is supplied. */
export function fleetHealthReport(args: {
  repoGuardPath: string;
  installedGuardPath?: string;
  configuredBinary: string;
  configuredPort: number;
  plistContent: string | null;
  read?: (p: string) => string;
  isExecutable?: (p: string) => boolean;
  platform?: string;
  /** #1106: the projection topology state (injectable; default: readFleetTopology()). */
  topology?: FleetTopologyState;
  /** #1775: the LaunchAgents dir the per-peer forward agents live in
   *  (production: ~/Library/LaunchAgents). Absent → no peer forward checks. */
  launchAgentsDir?: string;
  /** #1775: the reader peer-token store (default: fleet_peer_store's resolution). */
  peerStoreFile?: string;
}): FleetCheck[] {
  const topology = args.topology ?? readFleetTopology();
  const role = topology.kind === "ok" ? topology.role : "standalone";
  // The agents are read from the injected dir itself — `read` above is the
  // guard-file injection and never stands in for a plist read.
  const peerForwards = (): FleetCheck[] =>
    args.launchAgentsDir === undefined
      ? []
      : checkPeerForwards({ launchAgentsDir: args.launchAgentsDir, peerStoreFile: args.peerStoreFile, platform: args.platform, topology });

  if (topology.kind === "broken") {
    return [checkFleetRole({ topology, platform: args.platform })];
  }

  // Guard/settings/tunnel checks are only relevant for CLIENT machines — they
  // verify the engine-blocking guard, the binary redirect, and the SSH tunnel
  // that a client needs to reach the server. Servers and standalone machines
  // run their own engines and need none of that (peer fleet: every server runs
  // its own engine, ADR 0029). A broken projection also returns only the role
  // check, as its rendered fail.
  if (role !== "client" || topology.kind !== "ok") {
    return [
      checkFleetRole({ topology, platform: args.platform }),
      ...peerForwards(),
    ];
  }

  return [
    checkFleetRole({ topology, platform: args.platform }),
    checkFleetGuard(args.repoGuardPath, args.installedGuardPath, { read: args.read, isExecutable: args.isExecutable, platform: args.platform }),
    checkFleetSettings(args.configuredBinary, args.configuredPort, { platform: args.platform, topology }),
    checkFleetTunnel(args.plistContent, { platform: args.platform, topology }),
    ...peerForwards(),
  ];
}
