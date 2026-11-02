import { afterAll, describe, expect, test } from "bun:test"
import { authorized, front } from "../src/front.ts"
import { hostRoutes } from "../src/routes.ts"
import { IDLE_TIMEOUT, listen } from "../src/listener.ts"
import { basic, cleanup, freePort } from "./helpers.ts"

afterAll(cleanup)

const password = "pw-" + crypto.randomUUID()
const request = (path: string, init: RequestInit = {}) => new Request(`http://127.0.0.1:1${path}`, init)
const MATRIX = [
  "/",
  "/api/info",
  "/api/session",
  "/api/event",
  "/api/rpc/x/y",
  "/global/health",
  "/amicode/ping",
  "/amicode/health",
  "/amicode/nope",
  "/nope",
  "/assets/app.js",
  "/%2e%2e/etc/passwd",
  "//double/slash",
]

function build() {
  const seen: string[] = []
  const downstream = (req: Request) => {
    seen.push(new URL(req.url).pathname)
    return new Response("downstream", { status: 200 })
  }
  const own = (req: Request) => (new URL(req.url).pathname === "/amicode/own" ? new Response("own") : undefined)
  return { seen, handler: front({ password, own, downstream }) }
}

describe("deny-by-default front", () => {
  test.each(MATRIX)("%s without credentials is 401 with WWW-Authenticate and never reaches routing", async (p) => {
    const { seen, handler } = build()
    const res = await handler(request(p))
    expect(res.status).toBe(401)
    expect(res.headers.get("www-authenticate")).toMatch(/^Basic /)
    expect(seen).toEqual([])
  })

  test.each([
    ["wrong password", basic("nope")],
    ["wrong username", basic(password, "admin")],
    ["empty password", basic("")],
    ["bearer scheme", "Bearer " + password],
    ["malformed base64", "Basic !!!"],
    ["no colon", "Basic " + Buffer.from("opencode" + password).toString("base64")],
    ["basic without value", "Basic"],
    ["password prefix", basic(password.slice(0, -1))],
    ["password plus suffix", basic(password + "x")],
  ])("%s is 401", async (_name, header) => {
    const { seen, handler } = build()
    const res = await handler(request("/api/info", { headers: { authorization: header } }))
    expect(res.status).toBe(401)
    expect(seen).toEqual([])
    expect(authorized(request("/", { headers: { authorization: header } }), password)).toBe(false)
  })

  test("valid credentials reach downstream; own routes win over downstream", async () => {
    const { seen, handler } = build()
    const headers = { authorization: basic(password) }
    expect(await (await handler(request("/api/info", { headers }))).text()).toBe("downstream")
    expect(await (await handler(request("/amicode/own", { headers }))).text()).toBe("own")
    expect(seen).toEqual(["/api/info"])
  })

  test("a password containing a colon works (everything after the first colon)", async () => {
    const colon = "a:b:c-" + crypto.randomUUID()
    const handler = front({ password: colon, own: () => undefined, downstream: () => new Response("ok") })
    const res = await handler(request("/x", { headers: { authorization: basic(colon) } }))
    expect(res.status).toBe(200)
  })

  test("the upstream Response and Request pass through untouched (no buffering, signal intact)", async () => {
    const upstream = new Response(new ReadableStream({ start() {} }))
    let received: Request | undefined
    const handler = front({
      password,
      own: () => undefined,
      downstream: (req) => {
        received = req
        return upstream
      },
    })
    const req = request("/api/event", { headers: { authorization: basic(password) } })
    const res = await handler(req)
    expect(res).toBe(upstream)
    expect(received).toBe(req)
    expect(received?.signal).toBe(req.signal)
  })
})

describe("own routes", () => {
  const routes = hostRoutes({
    version: "9.9.9",
    dbPath: "/very/secret/dir/host.db",
    lockPid: 4242,
    startedAt: Date.now() - 5000,
    openStreams: () => 3,
    resume: false,
  })
  test("GET /amicode/ping", async () => {
    const res = await routes(request("/amicode/ping"))
    expect(res?.status).toBe(200)
    expect(await res?.json()).toEqual({ ok: true, host: "amicode-host", version: "9.9.9" })
  })
  test("GET /amicode/health reports db basename (never the full path), uptime, lock holder, open streams", async () => {
    const res = await routes(request("/amicode/health"))
    const text = await res!.text()
    expect(text).not.toContain("/very/secret")
    const body = JSON.parse(text)
    expect(body).toMatchObject({ ok: true, db: "host.db", lockHolderPid: 4242, openStreams: 3, resume: false })
    expect(body.uptimeMs).toBeGreaterThanOrEqual(5000)
  })
  test("unknown /amicode/* is answered by us with 404 and wrong methods with 405 (never forwarded)", async () => {
    expect((await routes(request("/amicode/nope")))?.status).toBe(404)
    expect((await routes(request("/amicode/ping", { method: "POST" })))?.status).toBe(405)
    expect(await routes(request("/api/info"))).toBeUndefined()
  })
})

describe("streaming over a real listener", () => {
  // A streaming downstream that records whether the client's disconnect cancelled its body.
  function streaming() {
    const state = { cancelled: false, pulls: 0 }
    const body = () =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          state.pulls++
          controller.enqueue(new TextEncoder().encode("data: tick\n\n"))
          return Bun.sleep(20)
        },
        cancel() {
          state.cancelled = true
        },
      })
    return { state, body }
  }

  async function readSome(url: string, headers: Record<string, string>) {
    const controller = new AbortController()
    const res = await fetch(url, { headers, signal: controller.signal })
    const reader = res.body!.getReader()
    const first = await reader.read()
    return { controller, status: res.status, first: new TextDecoder().decode(first.value) }
  }

  test("a client abort cancels the downstream body when the front returns it untouched", async () => {
    const { state, body } = streaming()
    const port = await freePort()
    const server = listen({
      port,
      fetch: front({ password, own: () => undefined, downstream: () => new Response(body(), { headers: { "content-type": "text/event-stream" } }) }),
    })
    try {
      const { controller, status, first } = await readSome(`http://127.0.0.1:${port}/api/event`, { authorization: basic(password) })
      expect(status).toBe(200)
      expect(first).toContain("tick")
      controller.abort()
      await Bun.sleep(500)
      expect(state.cancelled).toBe(true)
    } finally {
      server.stop(true)
    }
  })

  test("NEGATIVE CONTROL: a front that pumps the body leaks the downstream stream (harness can fail)", async () => {
    const { state, body } = streaming()
    const port = await freePort()
    const pumping = (req: Request) => {
      if (!authorized(req, password)) return new Response("no", { status: 401 })
      const reader = body().getReader()
      const sink = new ReadableStream<Uint8Array>({
        start(controller) {
          void (async () => {
            for (;;) {
              const next = await reader.read()
              if (next.done) return
              try {
                controller.enqueue(next.value)
              } catch {
                // client gone: keep draining anyway (the bug)
              }
            }
          })()
        },
        cancel() {},
      })
      return new Response(sink)
    }
    const server = listen({ port, fetch: pumping })
    try {
      const { controller } = await readSome(`http://127.0.0.1:${port}/x`, { authorization: basic(password) })
      controller.abort()
      await Bun.sleep(500)
      expect(state.cancelled).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  test("the listener binds loopback only, with the idle timeout disabled", async () => {
    const port = await freePort()
    const server = listen({ port, fetch: () => new Response("ok") })
    try {
      expect(server.hostname).toBe("127.0.0.1")
      expect(server.port).toBe(port)
      // Bun's default idleTimeout is 10 s, which kills an idle SSE stream before the 15 s heartbeat; the
      // end-to-end proof is the second-heartbeat test in host.test.ts.
      expect(IDLE_TIMEOUT).toBe(0)
    } finally {
      server.stop(true)
    }
  })
})
