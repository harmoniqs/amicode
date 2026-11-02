// Host-owned routes, answered after authentication and before the upstream server. The `/amicode/` namespace
// belongs to the host entirely: unknown paths in it are 404 here and never forwarded.
import path from "node:path"
import type { OwnRoutes } from "./front.ts"

export interface HostRouteState {
  readonly version: string
  readonly dbPath: string
  readonly lockPid: number
  readonly startedAt: number
  /** Streaming requests still open server-side (see server-seam). */
  readonly openStreams: () => number
  readonly resume: boolean
}

export function hostRoutes(state: HostRouteState): OwnRoutes {
  return (request) => {
    const pathname = new URL(request.url).pathname
    if (pathname !== "/amicode" && !pathname.startsWith("/amicode/")) return undefined
    const route = ROUTES[pathname]
    if (!route) return json({ ok: false, error: "not found" }, 404)
    if (request.method !== "GET" && request.method !== "HEAD") return json({ ok: false, error: "method not allowed" }, 405, { allow: "GET, HEAD" })
    return json(route(state))
  }
}

const ROUTES: Record<string, (state: HostRouteState) => unknown> = {
  "/amicode/ping": (state) => ({ ok: true, host: "amicode-host", version: state.version }),
  "/amicode/health": (state) => ({
    ok: true,
    host: "amicode-host",
    version: state.version,
    db: path.basename(state.dbPath), // basename only: the full path is not for clients
    uptimeMs: Date.now() - state.startedAt,
    lockHolderPid: state.lockPid,
    openStreams: state.openStreams(),
    resume: state.resume,
  }),
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })
}
