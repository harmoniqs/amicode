// The host-owned front: deny-by-default auth over EVERY path (known, custom, unknown), one custom
// /amicode/ping route, and a streaming-safe pass-through to whatever the seam gives us. This is the part
// of the design that does not depend on which seam is chosen.
import { timingSafeEqual } from "node:crypto"

export type Downstream = (request: Request) => Promise<Response> | Response

export function authorized(request: Request, password: string) {
  const header = request.headers.get("authorization") ?? ""
  const match = /^Basic\s+(.+)$/i.exec(header)
  if (!match) return false
  const decoded = Buffer.from(match[1], "base64").toString()
  const expected = Buffer.from(`opencode:${password}`)
  const actual = Buffer.from(decoded)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function unauthorized() {
  return new Response(JSON.stringify({ _tag: "UnauthorizedError", message: "Authentication required" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  })
}

export const pingResponse = () =>
  new Response(JSON.stringify({ ok: true, route: "/amicode/ping", at: Date.now() }), {
    headers: { "content-type": "application/json" },
  })

/** Deny-by-default front: nothing reaches `downstream` (or our own routes) without credentials. */
export function front(password: string, downstream: Downstream): Downstream {
  return (request) => {
    if (!authorized(request, password)) return unauthorized()
    if (new URL(request.url).pathname === "/amicode/ping") return pingResponse()
    return downstream(request)
  }
}

/** Forward to a separate server process; the request signal is forwarded so client aborts reach upstream. */
export function proxy(target: string, innerPassword: string, abort: "both" | "body-only" | "none" = "both"): Downstream {
  const inner = "Basic " + Buffer.from(`opencode:${innerPassword}`).toString("base64")
  return async (request) => {
    const url = new URL(request.url)
    const headers = new Headers(request.headers)
    headers.set("authorization", inner) // host credential never leaks upstream; upstream credential never leaks out
    headers.set("accept-encoding", "identity")
    headers.delete("host")
    const upstream = await fetch(new URL(url.pathname + url.search, target), {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      signal: abort === "both" ? request.signal : undefined, // "body-only": rely on response-body cancel alone; "none": negative control, must leak
      // @ts-expect-error bun accepts duplex for streaming request bodies
      duplex: "half",
      redirect: "manual",
    })
    const out = new Headers(upstream.headers)
    out.delete("content-encoding")
    out.delete("content-length")
    if (abort !== "none" || !upstream.body) return new Response(upstream.body, { status: upstream.status, headers: out })
    // NEGATIVE CONTROL ONLY: a naive pump that keeps draining upstream and ignores client cancel, so the upstream
    // subscription must leak. Proves the C6 harness can fail.
    const reader = upstream.body.getReader()
    const sink = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          let open = true
          for (;;) {
            const next = await reader.read().catch(() => ({ done: true, value: undefined }))
            if (next.done) {
              if (open) controller.close()
              return
            }
            if (open) {
              try {
                controller.enqueue(next.value!)
              } catch {
                open = false
              }
            }
          }
        })()
      },
      cancel() {},
    })
    return new Response(sink, { status: upstream.status, headers: out })
  }
}
