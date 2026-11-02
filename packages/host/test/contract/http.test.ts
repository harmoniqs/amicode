// Contract: the HTTP API shapes the host (and the Amicode extension through it) depend on, against a REAL host
// process on a contract port: /api/info, session create/list, /api/plugin, and the /api/event stream
// (`server.connected` first frame, `: heartbeat` cadence frame, abort releases the subscription).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cleanupContract, contractSandbox, startContractHost, stopContractHost, waitFor, type ContractHost } from "./support.ts"

afterAll(cleanupContract)

const sb = contractSandbox("http")
let host: ContractHost
beforeAll(async () => {
  host = await startContractHost(sb)
}, 90_000)
afterAll(async () => {
  if (host) await stopContractHost(host)
})

const call = (route: string, init: RequestInit = {}) =>
  fetch(host.url + route, { ...init, headers: { ...host.headers, ...((init.headers as Record<string, string>) ?? {}) } })

const sessionInfo = {
  id: expect.stringMatching(/^ses_/),
  projectID: expect.any(String),
  cost: expect.any(Number),
  tokens: { input: expect.any(Number), output: expect.any(Number), reasoning: expect.any(Number), cache: { read: expect.any(Number), write: expect.any(Number) } },
  time: { created: expect.any(Number), updated: expect.any(Number) },
  title: expect.any(String),
  location: { directory: expect.any(String) },
}

describe("contract: GET /api/info", () => {
  test("200 JSON with version, pid, hostname, urls, paths, capabilities", async () => {
    const res = await call("/api/info")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    expect(await res.json()).toMatchObject({
      version: expect.any(String),
      pid: expect.any(Number),
      hostname: expect.any(String),
      urls: expect.any(Array),
      paths: expect.any(Object),
      capabilities: { persistentPty: expect.any(Boolean) },
    })
  })
})

describe("contract: sessions", () => {
  test("POST /api/session answers { data: <Session.Info> } and GET /api/session lists it with a cursor", async () => {
    const created = await call("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "contract-probe", location: { directory: sb.work } }),
    })
    expect(created.status).toBe(200)
    const body = (await created.json()) as { data: { id: string } }
    expect(body).toEqual({ data: expect.objectContaining(sessionInfo) })
    expect(body.data).toMatchObject({ title: "contract-probe", location: { directory: sb.work } })

    const listed = await call("/api/session")
    expect(listed.status).toBe(200)
    const page = (await listed.json()) as { data: { id: string }[]; cursor: { previous: string; next: string } }
    expect(page.cursor).toEqual({ previous: expect.any(String), next: expect.any(String) })
    expect(page.data.map((s) => s.id)).toContain(body.data.id)
    expect(page.data.find((s) => s.id === body.data.id)).toEqual(expect.objectContaining(sessionInfo))
  })

  test("GET /api/session/:id/message answers a JSON envelope for a fresh session", async () => {
    const created = (await (
      await call("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "m", location: { directory: sb.work } }) })
    ).json()) as { data: { id: string } }
    const res = await call(`/api/session/${created.data.id}/message`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ data: expect.any(Array) })
  })
})

describe("contract: GET /api/plugin", () => {
  test("200 { location: { directory }, data: [] }", async () => {
    const res = await call("/api/plugin")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ location: { directory: sb.work }, data: expect.any(Array) })
  })
})

describe("contract: GET /api/event (SSE)", () => {
  test(
    "server.connected is the first data frame, `: heartbeat` comments follow on a ~15 s cadence, aborting releases the stream",
    async () => {
      const controller = new AbortController()
      const t0 = performance.now()
      const res = await call("/api/event", { headers: { accept: "text/event-stream" }, signal: controller.signal })
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/event-stream")
      expect(res.headers.get("cache-control")).toContain("no-cache")

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      const heartbeats: number[] = []
      const deadline = t0 + 40_000
      while (performance.now() < deadline && heartbeats.length < 2) {
        const next = await Promise.race([reader.read(), Bun.sleep(Math.max(1, deadline - performance.now())).then(() => undefined)])
        if (!next || next.done) break
        buffer += decoder.decode(next.value, { stream: true })
        const seen = buffer.split(": heartbeat\n\n").length - 1
        while (heartbeats.length < seen) heartbeats.push(performance.now() - t0)
      }

      // frames are blank-line separated; the first `data:` frame is the connection ack
      const frames = buffer.split("\n\n").filter(Boolean)
      const firstData = frames.find((frame) => frame.startsWith("data: "))!
      expect(JSON.parse(firstData.slice("data: ".length))).toEqual({ id: expect.stringMatching(/^evt_/), type: "server.connected", data: {} })
      // every later data frame is a JSON event with id + type
      for (const frame of frames.filter((f) => f.startsWith("data: ")))
        expect(JSON.parse(frame.slice("data: ".length))).toMatchObject({ id: expect.stringMatching(/^evt_/), type: expect.any(String) })
      // the keepalive is an SSE comment, never a data frame
      expect(frames.filter((f) => f.includes("heartbeat")).every((f) => f === ": heartbeat")).toBe(true)
      expect(heartbeats.length).toBe(2)
      expect(heartbeats[1]! - heartbeats[0]!).toBeGreaterThanOrEqual(10_000)
      expect(heartbeats[1]! - heartbeats[0]!).toBeLessThanOrEqual(25_000)

      controller.abort()
      await waitFor(async () => ((await (await call("/amicode/health")).json()) as { openStreams: number }).openStreams === 0, {
        timeoutMs: 8_000,
        what: "the event stream scope to close after the client aborted",
      })
    },
    90_000,
  )

  test("a new session is announced on the stream as a session.created event carrying its id", async () => {
    const controller = new AbortController()
    const res = await call("/api/event", { headers: { accept: "text/event-stream" }, signal: controller.signal })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const pump = (async () => {
      for (;;) {
        const next = await reader.read()
        if (next.done) return
        buffer += decoder.decode(next.value, { stream: true })
      }
    })().catch(() => undefined)
    await waitFor(() => buffer.includes("server.connected"), { what: "server.connected" })
    const created = (await (
      await call("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "evt", location: { directory: sb.work } }) })
    ).json()) as { data: { id: string } }
    const event = await waitFor(
      () =>
        buffer
          .split("\n\n")
          .filter((f) => f.startsWith("data: "))
          .map((f) => JSON.parse(f.slice(6)) as { type: string; data?: Record<string, unknown>; location?: unknown })
          .find((e) => e.type === "session.created" && JSON.stringify(e).includes(created.data.id)),
      { timeoutMs: 10_000, what: "session.created event" },
    )
    expect(event).toMatchObject({ id: expect.stringMatching(/^evt_/), type: "session.created", data: expect.any(Object) })
    controller.abort()
    await pump
  })
})
