// engine_state_push.ts — #1598: push engine lifecycle state to the app shell.
//
// The app-side engine toggle renders from these pushes (not from the engine's
// own status surface — which 503s when down). Every lifecycle transition calls
// pushEngineState; the fleet-role push tells the app whether to show the toggle
// at all (hidden on fleet-client windows).

import { ChatPanel } from "./chat_panel";
import { readFleetTopology, type FleetTopologyState } from "./fleet_topology";

/** The engine's lifecycle state as seen by the app toggle. */
export type EngineState = "on" | "booting" | "off";

/**
 * Post the current engine lifecycle state to all live app panels.
 * The app's engine toggle renders from these pushes, never from the
 * engine's own status surface (which 503s when the engine is down).
 */
export function pushEngineState(state: EngineState): void {
  ChatPanel.postToAll({
    source: "amicode",
    kind: "engine-state",
    state,
  });
}

/**
 * Post the fleet role to all live app panels.
 * The engine toggle hides when role === "client".
 */
export function pushFleetRole(topology?: FleetTopologyState): void {
  const topo = topology ?? readFleetTopology();
  const role = topo.kind === "ok" ? topo.role : "standalone";
  ChatPanel.postToAll({
    source: "amicode",
    kind: "fleet-role",
    role,
  });
}
