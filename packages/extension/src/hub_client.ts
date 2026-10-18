import * as nodeHttp from "node:http"
import { FleetPollHysteresis } from "./fleet_poll_hysteresis";

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

// ============================================================================
// The hub client SESSION — the probe/attach loop activation runs when the
// posture arms. Mirrors the fleet-client tunnel poll's proven shape
// (FleetPollHysteresis — one lost probe must not flip the posture) against the
// configured hub URL, and owns NO spawn surface at all: attach means "the
// panel's every server resolution points at the hub" (the caller wires the
// ready-URL → SSE connect → framed app on onAttach), detach means the hub went
// down through the hysteresis window. vscode-free; every effect is injected.
// ============================================================================

export interface HubClientSessionOptions {
  /** The normalized hub URL (readHubClientConfig's armed `url`). */
  hubUrl: string
  log(line: string): void
  /** Fired when the hub answers through attach hysteresis — the caller points
   *  EVERY server resolution (ready URL, SSE, the framed panel) at `url`. */
  onAttach(url: URL): void
  /** Fired when a previously-attached hub goes down through hysteresis. */
  onDetach(): void
  /** Optional Authorization header on probes (parity with the fleet client;
   *  the hub front is anonymous by design, so a stray header is ignored). */
  authHeader?: string
  /** The probe path (default "/"). */
  probePath?: string
  /** Probe budget: first attach / steady state (ms, default 1500 each — the
   *  fleet branch's steady budget; the hub is normally same-host). */
  attachTimeoutMs?: number
  steadyTimeoutMs?: number
  /** Poll cadence (ms, default 2000 — the fleet branch's cadence). */
  pollIntervalMs?: number
  /** Injectable hysteresis (tests); default = the production tuning. */
  poll?: FleetPollHysteresis
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch
}

export interface HubClientSession {
  stop(): void
  /** Fire one probe immediately (the restart command's re-probe — the
   *  hysteresis state stays with the session, never a second probe loop). */
  poke(): void
}

export function startHubClientSession(opts: HubClientSessionOptions): HubClientSession {
  const poll = opts.poll ?? new FleetPollHysteresis()
  // 2026-10-18: the probe deliberately does NOT use globalThis.fetch. The
  // VS Code extension host patches it (proxy support), and on this client the
  // patched fetch fails loopback URLs with no proxy configured — while curl,
  // the browser, and a bare node fetch all succeed (the "stuck booting"
  // cycle: posture armed, hub healthy, probe 'unreachable' forever). The
  // raw node:http request is host-proof: nothing in the ext host patches it.
  const fetchImpl =
    opts.fetchImpl ??
    ((input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const url = new URL(String(input))
        const req = nodeHttp.request(
          {
            host: url.hostname,
            port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
            path: url.pathname + url.search,
            method: (init?.method as string) || "GET",
            headers: (init?.headers as Record<string, string>) ?? undefined,
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on("data", (c: Buffer) => chunks.push(c))
            res.on("end", () =>
              resolve(
                new Response(Buffer.concat(chunks), {
                  status: res.statusCode ?? 0,
                  headers: (res.headers as unknown) as Record<string, string>,
                }),
              ),
            )
          },
        )
        req.on("error", reject)
        const signal = init?.signal as AbortSignal | undefined
        if (signal) {
          const arm = () => { try { req.destroy(new Error("probe timeout")) } catch {} }
          if (signal.aborted) arm()
          else signal.addEventListener("abort", arm, { once: true })
        }
        req.end()
      }))
  let hubUrl: URL
  try {
    hubUrl = new URL(opts.hubUrl)
  } catch {
    opts.log(`[hub] client mode REFUSED — ${opts.hubUrl} does not parse as a URL; falling back to base posture`)
    return { stop() {}, poke() {} }
  }
  const headers =
    opts.authHeader !== undefined ? { Authorization: opts.authHeader } : undefined
  opts.log(
    `[hub] client mode — amicode.hubServerUrl = ${hubUrl} — no local spawn (engine, service, runner); the panel resolves ${hubUrl}`,
  )
  const probe = async () => {
    let up = false
    try {
      const r = await fetchImpl(`${hubUrl.toString()}${opts.probePath ?? "/"}`, {
        signal: AbortSignal.timeout(poll.isReady ? (opts.steadyTimeoutMs ?? 1500) : (opts.attachTimeoutMs ?? 1500)),
        headers,
      })
      up = r.ok || (r.status >= 200 && r.status < 400)
    } catch {
      up = false // connection refused / timeout — the same hysteresis applies
    }
    const d = poll.onProbe(up)
    if (d.transition === "attach") {
      opts.log(`[hub] up at ${hubUrl} — panel attached`)
      opts.onAttach(new URL(hubUrl.toString()))
    } else if (d.transition === "detach") {
      opts.log(`[hub] hub down — ${d.failures} consecutive failed probes (threshold ${d.downThreshold}) — panel detached`)
      opts.onDetach()
    } else if (!up && d.ready && d.failures === 1) {
      // A failure streak just started while up — log the hold once (no spam).
      opts.log(`[hub] probe failed (1/${d.downThreshold}) — holding`)
    } else if (d.bootProbe && !up) {
      opts.log(`[hub] waiting for ${hubUrl} — unreachable, will retry`)
    }
  }
  const timer = setInterval(() => void probe(), opts.pollIntervalMs ?? 2000)
  void probe()
  return {
    stop() {
      clearInterval(timer)
    },
    poke() {
      void probe()
    },
  }
}

