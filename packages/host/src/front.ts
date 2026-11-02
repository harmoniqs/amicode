// The deny-by-default authenticating front. It wraps the WHOLE fetch: every path — standard, custom,
// unknown, non-/api — is checked before any routing happens. Past the check, host-owned routes win;
// everything else goes downstream untouched.
//
// The downstream Response is returned as-is. Never buffer or re-pump its body: the client's disconnect
// cancels that body, and cancel is what releases the upstream event subscription (H0c negative control:
// a pumping front leaks it). The incoming Request is likewise passed through so `request.signal` reaches
// the server.
import crypto from "node:crypto"

export type Handler = (request: Request) => Response | Promise<Response>
export type OwnRoutes = (request: Request) => Response | undefined | Promise<Response | undefined>

export const USERNAME = "opencode" // stock clients speak Basic with this user name

export function front(options: { password: string; own: OwnRoutes; downstream: Handler }): Handler {
  return async (request) => {
    if (!authorized(request, options.password)) return unauthorized()
    return (await options.own(request)) ?? options.downstream(request)
  }
}

export function authorized(request: Request, password: string) {
  const match = /^Basic\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")
  if (!match) return false
  const presented = Buffer.from(match[1]!, "base64").toString()
  return digest(presented).equals(digest(`${USERNAME}:${password}`))
}

// Comparing fixed-length digests keeps the comparison constant-time regardless of the presented length.
const digest = (value: string) => crypto.createHash("sha256").update(value).digest()

export function unauthorized() {
  return new Response(JSON.stringify({ _tag: "UnauthorizedError", message: "Authentication required" }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": 'Basic realm="amicode-host", charset="UTF-8"' },
  })
}
