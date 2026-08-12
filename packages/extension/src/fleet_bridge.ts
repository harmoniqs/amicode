// Fleet Bridge — extension-side bridge protocol for fleet state push and
// fleet action handling. The extension pushes FleetStateSnapshot to the app
// (via postMessage through the chat bridge), and receives fleet-action commands
// back from the app's context menu.
//
// Part of #358 (Fleet: sessions dropdown enrichment).

import * as fs from "node:fs";
import * as path from "node:path";
import { FLEET_REGISTRY_DIR } from "./fleet_launch";

// ============================================================================
// Fleet State Snapshot (extension → app)
// ============================================================================

export interface FleetSessionState {
  session_id: string;
  state: string;
  profile_name: string;
  tokens: number;
  host: string;
  current_step: string;
}

export interface FleetStateSnapshot {
  type: "fleet-state";
  payload: {
    sessions: FleetSessionState[];
  };
}

/** Build a FleetStateSnapshot from the current fleet records. */
export function buildFleetStateSnapshot(dir: string = FLEET_REGISTRY_DIR): FleetStateSnapshot {
  const sessions: FleetSessionState[] = [];
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".toml") && !f.startsWith("."));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, file), "utf8");
        const sessionId = file.replace(/\.toml$/, "");
        const stateMatch = raw.match(/^state\s*=\s*"([^"]+)"/m);
        const tokensMatch = raw.match(/^tokens\s*=\s*(\d+)/m);
        const hostMatch = raw.match(/^host\s*=\s*"([^"]+)"/m);
        const stepMatch = raw.match(/^current_step\s*=\s*"([^"]*)"/m);
        // Profile name is nested under [profile]
        const nameMatch = raw.match(/^name\s*=\s*"([^"]+)"/m);

        if (stateMatch) {
          sessions.push({
            session_id: sessionId,
            state: stateMatch[1],
            profile_name: nameMatch?.[1] ?? "",
            tokens: tokensMatch ? parseInt(tokensMatch[1], 10) : 0,
            host: hostMatch?.[1] ?? "",
            current_step: stepMatch?.[1] ?? "",
          });
        }
      } catch {
        // Skip unreadable records
      }
    }
  } catch {
    // Directory doesn't exist
  }
  return { type: "fleet-state", payload: { sessions } };
}

// ============================================================================
// Fleet Action (app → extension)
// ============================================================================

export interface FleetAction {
  type: "fleet-action";
  verb: "steer" | "stop" | "re-tier" | "view-details";
  session_id: string;
  params: Record<string, unknown>;
}

/** Validate and type-narrow a fleet action message from the bridge. */
export function parseFleetAction(msg: unknown): FleetAction | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== "fleet-action") return null;
  if (typeof m.verb !== "string") return null;
  if (typeof m.session_id !== "string" || m.session_id === "") return null;

  const verb = m.verb as string;
  if (!["steer", "stop", "re-tier", "view-details"].includes(verb)) return null;

  return {
    type: "fleet-action",
    verb: verb as FleetAction["verb"],
    session_id: m.session_id as string,
    params: (m.params && typeof m.params === "object" ? m.params : {}) as Record<string, unknown>,
  };
}

/** Write a signal file for a fleet action (same path as CLI verbs).
 *  Signal files are the single-writer mechanism: we never write records directly. */
export function enqueueFleetSignal(
  action: FleetAction,
  dir: string = FLEET_REGISTRY_DIR,
): string {
  const signalDir = path.join(dir, `${action.session_id}.signal.d`);
  fs.mkdirSync(signalDir, { recursive: true });
  const signalFile = path.join(signalDir, `${action.verb}-${Date.now()}.json`);
  fs.writeFileSync(signalFile, JSON.stringify({ verb: action.verb, params: action.params, ts: new Date().toISOString() }));
  return signalFile;
}

// ============================================================================
// Debounced push (extension-side, produces snapshots on record changes)
// ============================================================================

export type FleetStatePusher = (snapshot: FleetStateSnapshot) => void;

/** Create a debounced fleet state watcher. Returns a dispose function.
 *  Watches the fleet registry directory and pushes snapshots on change. */
export function createFleetStateWatcher(
  push: FleetStatePusher,
  opts: { debounceMs?: number; dir?: string } = {},
): { dispose: () => void } {
  const debounceMs = opts.debounceMs ?? 500;
  const dir = opts.dir ?? FLEET_REGISTRY_DIR;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: fs.FSWatcher | null = null;

  const debouncedPush = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      push(buildFleetStateSnapshot(dir));
    }, debounceMs);
  };

  try {
    fs.mkdirSync(dir, { recursive: true });
    watcher = fs.watch(dir, () => debouncedPush());
  } catch {
    // Watch may fail; fleet state still works via explicit refresh
  }

  return {
    dispose() {
      if (timer) clearTimeout(timer);
      watcher?.close();
    },
  };
}

// ============================================================================
// Bridge allowlist additions
// ============================================================================

/** The bridge message kinds this module adds to the protocol. */
export const FLEET_BRIDGE_KINDS = {
  /** Extension → app: fleet state snapshot (inbound to the app). */
  inbound: "fleet-state",
  /** App → extension: fleet action command (outbound from the app). */
  outbound: "fleet-action",
} as const;
