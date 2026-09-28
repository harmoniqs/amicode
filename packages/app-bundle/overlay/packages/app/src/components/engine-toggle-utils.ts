// engine-toggle.ts — #1598: pure logic for the engine on/off toggle.
//
// Message-driven state machine: the extension pushes engine-state and
// fleet-role messages; this module parses them into typed state. The
// component (engine-toggle.tsx) renders from this state.

/** Engine lifecycle state as pushed by the extension. */
export type EngineState = "on" | "booting" | "off"

/** Fleet role as pushed by the extension. */
export type FleetRole = "standalone" | "server" | "client"

/** Parse an engine-state message from the extension bridge. */
export function parseEngineStateMessage(
  data: unknown,
): EngineState | undefined {
  if (!data || typeof data !== "object") return undefined
  const d = data as { source?: string; kind?: string; state?: string }
  if (d.source !== "amicode" || d.kind !== "engine-state") return undefined
  if (d.state === "on" || d.state === "booting" || d.state === "off") return d.state
  return undefined
}

/** Parse a fleet-role message from the extension bridge. */
export function parseFleetRoleMessage(
  data: unknown,
): FleetRole | undefined {
  if (!data || typeof data !== "object") return undefined
  const d = data as { source?: string; kind?: string; role?: string }
  if (d.source !== "amicode" || d.kind !== "fleet-role") return undefined
  if (d.role === "standalone" || d.role === "server" || d.role === "client") return d.role
  return undefined
}

/** Send a bridge command to the extension (stop or restart the engine). */
export function sendEngineCommand(state: EngineState): void {
  if (state === "on") {
    // Engine is on → stop it
    window.parent?.postMessage(
      { source: "amicode", kind: "command", command: "amicode.stopServer" },
      "*",
    )
  } else if (state === "off") {
    // Engine is off → restart it
    window.parent?.postMessage(
      { source: "amicode", kind: "command", command: "amicode.restartServer" },
      "*",
    )
  }
  // booting → locked, no action
}
