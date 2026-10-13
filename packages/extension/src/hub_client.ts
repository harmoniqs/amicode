// ============================================================================
// #1760 P4 — the hub-host client posture. ONE setting, `amicode.hubServerUrl`
// (string, default ""), arms a cross-platform client mode: the extension
// spawns NOTHING (no local engine on 4094, no amicode service on 4095, no
// keepalive, no adopt) and the panel's ENTIRE server resolution points at the
// configured hub URL — the framed app's document origin IS the hub, so the
// app's server registry, global SDK event stream, session views, question
// dock, and replies all resolve to the hub (one server, no split).
//
// Why this shape (vs `amicode.clientMode: "hub"` carrying a URL): it matches
// the repo's flat-key settings convention — an empty string means "absent"
// and the base posture is byte-identical (the same H3 discipline as
// fleetHubUrl / opencodeBinary / defaultModel) — and a mode enum would still
// need a companion URL key, two keys to keep coherent instead of one. The
// posture is host-level (the machine IS the hub host, or points at one over
// the wire): it is EXPLICIT configuration, never inferred from platform (the
// darwin-only isFleetClientGuard stays untouched — the mac fleet-client
// posture is a different, existing client mode) and never inferred from the
// fleet projection (role="server" does not auto-arm; the setting is the
// record).
//
// Default URL NOTE: the setting has no default VALUE (empty = today's
// behavior); the documented convention value on the hub host itself is
// http://127.0.0.1:4097 — the frontdoor's app origin (it also listens on
// 4096; 4097 is the fresh-origin app port fleet.json points clients at).
//
// vscode-free on purpose (the settings read is handed in), so the posture
// decision + the session loop are unit-testable without the VS Code host.
// ============================================================================

/** The hub plane's reserved ports — the frontdoor (4096/4097), the hub's
 * engine-side service (4095), and the hub runner's engine upstream (4094).
 * Nothing the EXTENSION starts may ever bind these (the hub owns them); see
 * guardReservedHubPort. */
export const RESERVED_HUB_PORTS = [4094, 4095, 4096, 4097] as const

export interface HubClientConfig {
  /** True when the setting names a valid hub URL — the client posture arms. */
  armed: boolean
  /** The normalized hub URL when armed (protocol + host, no trailing slash). */
  url: string
  /** A named reason for the unarmed (or refused) state — logged, never silent. */
  reason: string
}

/** Read the `amicode.hubServerUrl` setting into the posture decision.
 *  Empty/whitespace → unarmed (today's behavior). A non-http(s) or
 *  unparseable value → unarmed with the named refusal (fail to the BASE
 *  posture, loudly — never point the panel at a garbage URL, never spawn
 *  silently either: the reason line is the operator's fix pointer). */
export function readHubClientConfig(rawUrl: string | undefined): HubClientConfig {
  const raw = (rawUrl ?? "").trim()
  if (raw === "") return { armed: false, url: "", reason: "no amicode.hubServerUrl configured" }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { armed: false, url: "", reason: `amicode.hubServerUrl is not a valid URL: ${raw}` }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { armed: false, url: "", reason: `amicode.hubServerUrl must be http(s): ${raw}` }
  }
  return { armed: true, url: parsed.toString().replace(/\/$/, ""), reason: "armed" }
}

/** Which client posture activation takes. The hub setting is EXPLICIT
 *  configuration and outranks the INFERRED darwin fleet-client guard (the
 *  guard reads a projection cache the operator didn't write into their
 *  settings; the setting is the record). Everything else keeps today's
 *  ladder byte-identical: fleet client needs its guard binary, local needs
 *  the engine binary, no binary → no chat. */
export type BootPosture = "hub-client" | "fleet-client" | "local" | "none"

export function bootPosture(input: { hubArmed: boolean; fleetClient: boolean; hasBinary: boolean }): BootPosture {
  if (input.hubArmed) return "hub-client"
  if (input.fleetClient && input.hasBinary) return "fleet-client"
  return input.hasBinary ? "local" : "none"
}

/** True when the port sits in the hub plane's reserved range (4094-4097).
 *  Nothing the EXTENSION starts may bind these — the hub (frontdoor +
 *  runner-backed service + engine) owns them; an extension spawn there races
 *  the hub's sockets (the erlich 4094 three-bounce pattern). */
export function isReservedHubPort(port: number): boolean {
  return (RESERVED_HUB_PORTS as readonly number[]).includes(port)
}

/** Guard a configured fixed port: a reserved hub port is REFUSED (returns 0 →
 *  the caller falls back to ephemeral) with a named log line — never a silent
 *  spawn onto the hub's socket, never a silent settings rewrite. `label` names
 *  the configured source in the log (e.g. "amicode.opencodePort"). Ports
 *  outside the range — including 0 (unset) — pass through untouched. */
export function guardReservedHubPort(port: number, label: string, log: (line: string) => void): number {
  if (!isReservedHubPort(port)) return port
  log(
    `[hub] ${label} = ${port} is in the reserved hub port range ${RESERVED_HUB_PORTS[0]}-${RESERVED_HUB_PORTS[RESERVED_HUB_PORTS.length - 1]} — the hub plane owns it; ignoring the pin and using a free ephemeral port`,
  )
  return 0
}

