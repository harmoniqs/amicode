// Fleet Version Compatibility — protocol negotiation between client and server.
// The client checks the server's capabilities on connect (via the health probe)
// and determines the compatibility state: compatible, degraded, or incompatible.
//
// Design: Option B (semver + capability negotiation with standalone fallback).
// - Compatible: same major version, full feature set
// - Degraded: minor mismatch, basic sessions work, new features don't render
// - Incompatible: major version mismatch, warn and offer Go Standalone

import type { SshExec } from "./fleet_ssh";
import { defaultSshExec } from "./fleet_ssh";

// ============================================================================
// Version + Capabilities
// ============================================================================

/** The capabilities a server can advertise. Additive — new capabilities are
 *  added without removing old ones. A client ignores capabilities it doesn't
 *  understand and only offers UI for the ones it knows. */
export const KNOWN_CAPABILITIES = [
  "sessions",         // core: create/list/view sessions
  "fleet-state",      // push fleet state snapshots
  "fleet-action",     // accept fleet action signals (steer/stop/re-tier)
  "profiles",         // fleet profiles CRUD
  "host-settings",    // remote host settings read/write
  "sweep",            // sweep orphaned sessions
  "topology",         // topology graph data
] as const;

export type Capability = (typeof KNOWN_CAPABILITIES)[number];

export interface ServerInfo {
  version: string;
  schema: number;
  capabilities: string[];
}

export type CompatState = "compatible" | "degraded" | "incompatible";

export interface CompatResult {
  state: CompatState;
  serverVersion: string;
  clientVersion: string;
  missingCapabilities: string[];
  message: string;
}

// ============================================================================
// Semver parsing (minimal — major.minor.patch)
// ============================================================================

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemVer(version: string): SemVer | null {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

// ============================================================================
// Compatibility check (pure — unit-testable)
// ============================================================================

/** Determine the compatibility state between client and server.
 *  - Same major version → compatible (or degraded if server has newer capabilities)
 *  - Different major version → incompatible */
export function checkCompatibility(
  clientVersion: string,
  serverInfo: ServerInfo,
  clientCapabilities: readonly string[] = KNOWN_CAPABILITIES,
): CompatResult {
  const client = parseSemVer(clientVersion);
  const server = parseSemVer(serverInfo.version);

  if (!client || !server) {
    return {
      state: "degraded",
      serverVersion: serverInfo.version,
      clientVersion,
      missingCapabilities: [],
      message: "Could not parse version — operating in degraded mode",
    };
  }

  // Major version mismatch → incompatible
  if (client.major !== server.major) {
    return {
      state: "incompatible",
      serverVersion: serverInfo.version,
      clientVersion,
      missingCapabilities: serverInfo.capabilities.filter((c) => !clientCapabilities.includes(c)),
      message: `Major version mismatch: client v${clientVersion}, server v${serverInfo.version}. Go Standalone or update your extension.`,
    };
  }

  // Same major — check if server has capabilities the client doesn't know
  const unknown = serverInfo.capabilities.filter((c) => !clientCapabilities.includes(c));

  if (unknown.length > 0 || server.minor > client.minor) {
    return {
      state: "degraded",
      serverVersion: serverInfo.version,
      clientVersion,
      missingCapabilities: unknown,
      message: `Server is newer (v${serverInfo.version} vs v${clientVersion}). Basic features work — rebuild extension for full capabilities.`,
    };
  }

  return {
    state: "compatible",
    serverVersion: serverInfo.version,
    clientVersion,
    missingCapabilities: [],
    message: "Fully compatible",
  };
}

// ============================================================================
// Server probe (fetches ServerInfo from the canonical server)
// ============================================================================

/** Probe the server's version endpoint over SSH (reads a version file the
 *  server writes on start). Falls back to inferring from the binary --version. */
export async function probeServerInfo(
  target: string,
  opts: { exec?: SshExec; port?: number } = {},
): Promise<ServerInfo | null> {
  const exec = opts.exec ?? defaultSshExec;

  // Try the fleet version file first (written by the server on start)
  const versionFileResult = await exec(target, "cat ~/.amico/ops/fleet/server_version.json 2>/dev/null");
  if (versionFileResult.ok && versionFileResult.stdout.trim()) {
    try {
      const info = JSON.parse(versionFileResult.stdout.trim());
      if (info.version && Array.isArray(info.capabilities)) {
        return {
          version: String(info.version),
          schema: Number(info.schema ?? 1),
          capabilities: info.capabilities.map(String),
        };
      }
    } catch {
      // Fall through
    }
  }

  // Fallback: probe the binary's version
  const versionResult = await exec(target, "~/.local/bin/opencode --version 2>/dev/null || opencode --version 2>/dev/null");
  if (versionResult.ok && versionResult.stdout.trim()) {
    const version = versionResult.stdout.trim().replace(/^v/, "");
    return {
      version,
      schema: 1,
      capabilities: ["sessions"], // Assume minimal if no version file
    };
  }

  return null;
}

/** Write the server version file (called during server setup/rebuild).
 *  The server writes this on start so clients can probe without hitting the
 *  HTTP API (which may not be up yet during health checks). */
export function buildServerVersionFile(version: string, capabilities?: string[]): string {
  const info: ServerInfo = {
    version,
    schema: 1,
    capabilities: capabilities ?? [...KNOWN_CAPABILITIES],
  };
  return JSON.stringify(info, null, 2);
}

// ============================================================================
// Client-side state (used by the Fleet Panel to show compatibility status)
// ============================================================================

export interface FleetCompatState {
  checked: boolean;
  result?: CompatResult;
}

/** Get the current extension version from package.json (compile-time constant). */
export const CLIENT_VERSION = "0.2.1"; // Matches package.json version
