// Fleet topology data — pure functions that build FleetNode[] + FleetEdge[]
// from the fleet config and health probes. Used by the fleet panel host to
// push topology updates to the webview.
//
// Part of #353 (Fleet Panel: SVG topology graph with clickable nodes).

import * as os from "node:os";
import { readFleetConfig, type FleetConfig } from "./fleet_fallback";
import type { FleetNode, FleetEdge } from "./fleet_panel";

/** Build the topology graph data from the current fleet configuration.
 *  This is a pure projection from config → graph nodes + edges. */
export function buildTopologyFromConfig(
  config: FleetConfig | null,
  opts: {
    localHostname?: string;
    serverHealthy?: boolean;
    clientsHealthy?: Map<string, boolean>;
    sessionCounts?: Map<string, number>;
  } = {},
): { nodes: FleetNode[]; edges: FleetEdge[] } {
  const localHostname = opts.localHostname ?? os.hostname();
  const role = config?.role ?? "standalone";

  if (role === "standalone" || !config) {
    return { nodes: [], edges: [] };
  }

  const nodes: FleetNode[] = [];
  const edges: FleetEdge[] = [];
  const serverHost = config.canonical?.host ?? "server";
  const serverHealthy = opts.serverHealthy ?? true;

  // Server node
  const serverId = "server";
  nodes.push({
    id: serverId,
    hostname: serverHost,
    role: "server",
    isLocal: role === "server",
    healthy: serverHealthy,
    sessionCount: opts.sessionCounts?.get(serverId) ?? 0,
  });

  // Local client node (if this machine is a client)
  if (role === "client") {
    const clientId = `client-${localHostname}`;
    nodes.push({
      id: clientId,
      hostname: localHostname,
      role: "client",
      isLocal: true,
      healthy: true, // local machine is always "healthy" from its own perspective
      sessionCount: opts.sessionCounts?.get(clientId) ?? 0,
    });
    edges.push({
      from: serverId,
      to: clientId,
      connected: serverHealthy,
    });
  }

  return { nodes, edges };
}

/** Read the current fleet config and build topology data.
 *  Convenience wrapper around buildTopologyFromConfig. */
export function readTopology(opts?: {
  serverHealthy?: boolean;
}): { nodes: FleetNode[]; edges: FleetEdge[] } {
  const config = readFleetConfig();
  return buildTopologyFromConfig(config, {
    serverHealthy: opts?.serverHealthy,
  });
}
