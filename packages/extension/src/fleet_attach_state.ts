// Machine-posture state for the agent-context plugin (#780) — the SINGLE
// WRITER of ~/.amico/ops/fleet/attach-state.json, written by the extension's
// fleet attach loop on attach-state TRANSITIONS only (attach, degrade,
// hub-lost, hub-regained — never per poll tick) and on standalone-mode
// changes. The plugin (opencode-plugin/stack_state.ts) is read-only: it
// renders the posture block from this file and does NO network probes.
//
// Schema (the plugin's strict reader in stack_state.ts must stay in sync):
//   { hostname, mode: "fleet"|"standalone"|"degraded", hubName?, hubBaseUrl?,
//     reachable, lastOkAt?, lastRttMs?, since, updatedAt }   // ISO strings
//
// `since` = when the current mode was entered (the fallback time a standalone
// machine names); `lastOkAt` = last successful probe (preserved across
// degrade). `fleet.json` remains the role config — this file is live truth.

import * as fs from "node:fs";
import * as path from "node:path";
import { hostname } from "node:os";
import { FLEET_DIR } from "./fleet_fallback";

export const FLEET_ATTACH_STATE_PATH = path.join(FLEET_DIR, "attach-state.json");

export type FleetAttachMode = "fleet" | "standalone" | "degraded";

export interface FleetAttachState {
  hostname: string;
  mode: FleetAttachMode;
  hubName?: string;
  hubBaseUrl?: string;
  reachable: boolean;
  /** Last successful probe (ISO). Preserved when the hub degrades. */
  lastOkAt?: string;
  lastRttMs?: number;
  /** When the current mode was entered (ISO) — the standalone fallback time. */
  since: string;
  updatedAt: string;
}

/** Previous posture from disk. Corrupt or missing → undefined (unknown). */
export function readAttachState(p: string = FLEET_ATTACH_STATE_PATH): FleetAttachState | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as FleetAttachState;
    if (parsed && typeof parsed === "object" && typeof parsed.mode === "string") return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Atomic write (tmp + rename) — the plugin may read concurrently. */
export function writeAttachState(state: FleetAttachState, p: string = FLEET_ATTACH_STATE_PATH): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

/** The transition decision for the client attach loop: a write is due ONLY
 *  when the attach state changes (unknown→attach, attach→degraded,
 *  degraded→attach). Steady fleet or steady degraded = no write — the file's
 *  claims stay timestamped at their transition. A corrupt/missing previous
 *  state is treated as unknown (so the first probe after corruption writes). */
export function postureTransition(
  prev: FleetAttachState | "corrupt" | undefined,
  probe: { up: boolean; rttMs?: number },
  nowMs: number,
  hub: { name?: string; baseUrl?: string } = {},
  host: string = hostname(),
): { changed: boolean; state?: FleetAttachState } {
  const prevMode = prev && prev !== "corrupt" ? prev.mode : undefined;
  const mode: FleetAttachMode = probe.up ? "fleet" : "degraded";
  if (prevMode === mode) return { changed: false };
  const now = new Date(nowMs).toISOString();
  const state: FleetAttachState = {
    hostname: host,
    mode,
    ...(hub.name ? { hubName: hub.name } : {}),
    ...(hub.baseUrl ? { hubBaseUrl: hub.baseUrl } : {}),
    reachable: probe.up,
    ...(probe.up
      ? { lastOkAt: now, ...(probe.rttMs !== undefined ? { lastRttMs: probe.rttMs } : {}) }
      : prev && prev !== "corrupt" && prev.lastOkAt
        ? { lastOkAt: prev.lastOkAt, ...(prev.lastRttMs !== undefined ? { lastRttMs: prev.lastRttMs } : {}) }
        : {}),
    since: now,
    updatedAt: now,
  };
  return { changed: true, state };
}

/** Write (or refresh) the standalone posture. A machine already standalone
 *  keeps its original `since` — the fallback time must not drift across
 *  extension restarts. A transition out of fleet/degraded (Go Standalone)
 *  stamps since=now. */
export function recordStandalonePosture(
  opts: { path?: string; hostname?: string; nowMs?: number; hub?: { name?: string; baseUrl?: string } } = {},
): FleetAttachState {
  const p = opts.path ?? FLEET_ATTACH_STATE_PATH;
  const nowMs = opts.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const prev = readAttachState(p);
  const state: FleetAttachState = {
    hostname: opts.hostname ?? hostname(),
    mode: "standalone",
    ...(opts.hub?.name ? { hubName: opts.hub.name } : {}),
    ...(opts.hub?.baseUrl ? { hubBaseUrl: opts.hub.baseUrl } : {}),
    reachable: false,
    ...(prev?.mode === "standalone" && prev.since ? { since: prev.since } : { since: now }),
    updatedAt: now,
  };
  writeAttachState(state, p);
  return state;
}

// Default-path convenience for callers that need the standalone fallback hub
// identity from the (possibly stale) fleet config.
export function standaloneHubFromConfig(cfg: { canonical?: { host?: string; port?: number; sshAlias?: string } } | null): { name?: string; baseUrl?: string } {
  const name = cfg?.canonical?.sshAlias ?? cfg?.canonical?.host;
  return {
    ...(name ? { name } : {}),
    ...(cfg?.canonical?.port ? { baseUrl: `http://127.0.0.1:${cfg.canonical.port}` } : {}),
  };
}
