import { afterEach, describe, expect } from "bun:test"
import * as Net from "node:net"
import { Effect, Layer, Queue, Schema, Stream } from "effect"
import { HttpServer } from "effect/unstable/http"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { makeSseTickTelemetry, resetSseTickTelemetry, setSseTickTelemetry } from "../../src/server/shared/sse-tick-telemetry"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const EventData = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Any),
})

const readEvent = (reader: Queue.Dequeue<Uint8Array>) =>
  Effect.gen(function* () {
    // Frames now carry the SSE `id` line (the reconnect cursor) ahead of the
    // data line, and a chunk may hold the id line alone — scan for the data.
    let line: string | undefined
    while (line === undefined) {
      const value = yield* Queue.take(reader).pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () => Effect.fail(new Error("timed out waiting for event")),
        }),
      )
      line = new TextDecoder()
        .decode(value)
        .split("\n")
        .find((candidate) => candidate.startsWith("data: "))
    }
    return Schema.decodeUnknownSync(EventData)(JSON.parse(line.slice("data: ".length)))
  })

const openEventStream = (directory: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(EventPaths.event, directory)
    const reader = yield* Queue.unbounded<Uint8Array>()
    yield* response.stream.pipe(
      Stream.runForEach((value) => Queue.offer(reader, value)),
      Effect.forkScoped,
    )
    return { response, reader }
  })

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const it = testEffect(httpApiLayer)

describe("event HttpApi", () => {
  it.instance(
    "serves event stream",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { response, reader } = yield* openEventStream(directory)

        expect(response.status).toBe(200)
        expect(response.headers["content-type"]).toContain("text/event-stream")
        expect(response.headers["cache-control"]).toBe("no-cache, no-transform")
        expect(response.headers["x-accel-buffering"]).toBe("no")
        expect(response.headers["x-content-type-options"]).toBe("nosniff")
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "keeps the event stream open after the initial event",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        // If no second event arrives within 250ms, the stream is still open.
        const status = yield* Queue.take(reader).pipe(
          Effect.as("event" as const),
          Effect.timeoutOrElse({ duration: "250 millis", orElse: () => Effect.succeed("open" as const) }),
        )
        expect(status).toBe("open")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "delivers instance events after the initial event",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        const created = yield* requestInDirectory("/session", directory, { method: "POST" })
        expect(created.status).toBe(200)
        expect(yield* readEvent(reader)).toMatchObject({ type: "session.created" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})

describe("event heartbeat tick telemetry (#1798 phase A)", () => {
  afterEach(() => {
    resetSseTickTelemetry()
  })

  it.instance(
    "the /event route heartbeats at the telemetry cadence and logs an SSE-TICK line per tick",
    () =>
      Effect.gen(function* () {
        const lines: Array<string> = []
        const telemetry = makeSseTickTelemetry({
          cadenceMs: 100,
          watchdogIntervalMs: 2_000,
          probeIntervalMs: 500,
          sink: (line) => lines.push(line),
        })
        setSseTickTelemetry(telemetry)

        const { directory } = yield* TestInstance
        const { response, reader } = yield* openEventStream(directory)
        expect(response.status).toBe(200)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        // The heartbeat cadence follows the telemetry singleton — at the fast
        // test cadence the next frame on the wire IS the heartbeat.
        const heartbeat = yield* readEvent(reader)
        expect(heartbeat.type).toBe("server.heartbeat")

        // Every live connection-carrying route logs its tick line: route,
        // connection, cadence, the emitting fiber's identity, queue depth,
        // event-loop lag, and RSS (the #1798 discriminator payload).
        const tickLines = lines.filter((line) => line.startsWith("SSE-TICK"))
        expect(tickLines.length).toBeGreaterThanOrEqual(1)
        expect(tickLines[0]).toMatch(
          /^SSE-TICK route=\/event conn=\S+ cadence_ms=100 queue_depth=0 fiber=\d+ lag_ms=\d+ rss_bytes=\d+ ts_ms=\d+$/,
        )
        expect(telemetry.snapshot().connections).toBe(1)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "unregisters the connection when the stream closes — an empty registry never SELF-STALLs",
    () =>
      Effect.gen(function* () {
        const lines: Array<string> = []
        const telemetry = makeSseTickTelemetry({
          cadenceMs: 100,
          watchdogIntervalMs: 250,
          probeIntervalMs: 500,
          sink: (line) => lines.push(line),
        })
        setSseTickTelemetry(telemetry)

        const { directory } = yield* TestInstance
        // Inner scope: closing it abandons the response, which ends the
        // server-side stream and runs the finalizer that unregisters.
        yield* Effect.gen(function* () {
          const { reader } = yield* openEventStream(directory)
          expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })
          expect(telemetry.snapshot().connections).toBe(1)
        }).pipe(Effect.scoped)

        // The finalizer is async — poll until the registry drains.
        yield* Effect.forEach(
          [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
          () =>
            Effect.gen(function* () {
              if (telemetry.snapshot().connections > 0) yield* Effect.sleep("100 millis")
            }),
          { discard: true },
        )
        expect(telemetry.snapshot().connections).toBe(0)

        // With zero live connections the watchdog has nothing to declare
        // silent — no SELF-STALL line may fire over several windows.
        yield* Effect.sleep("600 millis")
        const stalls = lines.filter((line) => line.startsWith("SELF-STALL"))
        expect(stalls.length).toBe(0)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})

// ── #1798 phase C: bounded fan-out writes — a dead subscriber wedges NOTHING ──
//
// The named mechanism (captured live 2026-10-13/14): the frontdoor recycler
// kills its upstream sockets FIN-less (Linux close() with a concurrent reader
// blocked in recv sends no FIN — the frontdoor's own #1757 comment). The
// engine's SSE write path then parks forever on the corpse socket — the
// platform writer waits for a `drain` event that never comes — and the
// per-connection recurring emission (Stream.tick + the bus fan-out) wedges
// while HTTP stays healthy. These tests pin the fix: fan-out writes are
// bounded; when the bound trips the corpse is dropped (registry unregisters
// it, an SSE-DROP telemetry line names the drop, the socket is closed
// engine-side) and every other subscriber keeps receiving events + heartbeats.
describe("bounded fan-out writes (#1798 phase C)", () => {
  afterEach(() => {
    resetSseTickTelemetry()
  })

  interface RawSseClient {
    heartbeats(): number
    events(): number
    isClosed(): boolean
    close(): void
  }

  // A raw TCP SSE client against the real test server (node:http, the same
  // platform production uses), reading continuously — the healthy subscriber
  // the corpse must not drag down. (The corpse itself needs kernel-level
  // receive-buffer pinning and must live in another process — see
  // spawnCorpse.)
  const openRawSse = (address: { hostname: string; port: number }, directory: string) =>
    Effect.callback<RawSseClient>(function (resume) {
      const socket = Net.connect({ host: address.hostname, port: address.port })
      let body = ""
      let headersDone = false
      let connected = false
      const client: RawSseClient = {
        heartbeats() {
          return body.split('"type":"server.heartbeat"').length - 1
        },
        events() {
          return body.split('"type":"session.created"').length - 1
        },
        isClosed() {
          return socket.closed
        },
        close() {
          socket.end()
        },
      }
      socket.setEncoding("utf8")
      socket.on("error", () => {})
      socket.on("close", () => {})
      socket.on("data", (chunk: string) => {
        if (headersDone) {
          body += chunk
          return
        }
        const raw = body + chunk
        const split = raw.indexOf("\r\n\r\n")
        if (split === -1) {
          body = raw
          return
        }
        body = raw.slice(split + 4)
        headersDone = true
        if (!connected && body.includes("server.connected")) {
          connected = true
          resume(Effect.succeed(client))
        }
      })
      socket.on("connect", () => {
        socket.write(
          `GET ${EventPaths.event} HTTP/1.1\r\n` +
            `Host: ${address.hostname}:${address.port}\r\n` +
            `Accept: text/event-stream\r\n` +
            `x-opencode-directory: ${directory}\r\n` +
            `Connection: keep-alive\r\n\r\n`,
        )
      })
    }).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail(new Error("raw SSE connection never received the connect frame")),
      }),
    )

  const waitFor = (message: string, predicate: () => boolean, budgetMs = 5_000) =>
    Effect.gen(function* () {
      const deadline = Date.now() + budgetMs
      while (Date.now() < deadline) {
        if (predicate()) return
        yield* Effect.sleep("50 millis")
      }
      return yield* Effect.fail(new Error(message))
    })

  const sseAddress = () =>
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer
      const address = server.address
      if (address._tag !== "TcpAddress") return yield* Effect.fail(new Error("expected a TCP test server"))
      return { hostname: address.hostname, port: address.port }
    })

  // The corpse subscriber: an external socket with a 4KB kernel receive
  // buffer, held open, blocked in recv, never sent a FIN — exactly the
  // frontdoor's #1757 kill shape. It must be external: bun's own sockets
  // absorb multi-MB of SSE data into userland buffers before kernel
  // backpressure reaches the engine's write path, so an in-process client
  // cannot produce the stall deterministically. The tiny receive buffer pins
  // the stall threshold at ~527KB regardless of runtime socket buffering.
  //
  // Bun runtime gap (measured, 2026-10-14): res.destroy(), socket.destroy()
  // and socket.resetAndDestroy() all mark the server-side socket destroyed
  // but send NO FIN/RST to the peer — the wire-level close is unreachable
  // from the engine under bun, so the test cannot assert the corpse sees a
  // connection end. The engine-side drop (registry teardown + the SSE-DROP
  // line + the destroy the route performs) is asserted instead; the wire FIN
  // is the frontdoor slice's end of the contract.
  const CORPSE_SCRIPT = `
import os, socket, sys, time
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
s.connect(("127.0.0.1", int(os.environ["CORPSE_PORT"])))
directory = os.environ["CORPSE_DIRECTORY"]
s.sendall(("GET /event HTTP/1.1\\r\\nHost: x\\r\\nAccept: text/event-stream\\r\\n"
           "x-opencode-directory: " + directory + "\\r\\n\\r\\n").encode())
s.recv(1024)  # read like the frontdoor did up to the kill, then block forever
time.sleep(60)
sys.exit(1)
`

  const spawnCorpse = (address: { port: number }, directory: string) =>
    Effect.gen(function* () {
      const corpse = Bun.spawn(["python3", "-c", CORPSE_SCRIPT], {
        env: {
          ...process.env,
          CORPSE_PORT: String(address.port),
          CORPSE_DIRECTORY: directory,
        },
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => corpse.kill()))
      return { kill: () => corpse.kill() }
    })

  it.instance(
    "drops a FIN-less corpse subscriber: others keep their heartbeats, the registry unregisters the corpse, SELF-STALL never fires",
    () =>
      Effect.gen(function* () {
        const lines: Array<string> = []
        const telemetry = makeSseTickTelemetry({
          cadenceMs: 100,
          watchdogIntervalMs: 2_000,
          probeIntervalMs: 500,
          sink: (line) => lines.push(line),
        })
        setSseTickTelemetry(telemetry)

        const { directory } = yield* TestInstance
        const address = yield* sseAddress()
        const healthy = yield* openRawSse(address, directory)
        yield* spawnCorpse(address, directory)
        yield* Effect.addFinalizer(() => Effect.sync(() => healthy.close()))

        // Pump oversized session.created events until the corpse's write path
        // parks on the full socket. The corpse's 4KB receive buffer stalls
        // the engine's write at ~527KB (measured); the frames the platform
        // writer never takes back up the bounded write queue, heartbeats keep
        // topping it up, and the offer bound drops the corpse.
        const bigTitle = "x".repeat(65_536)
        const pumpDeadline = Date.now() + 14_000
        for (let i = 0; i < 24 && Date.now() < pumpDeadline; i++) {
          const created = yield* requestInDirectory("/session", directory, {
            method: "POST",
            body: JSON.stringify({ title: `${i}-${bigTitle}` }),
          })
          if (created.status !== 200) break
          yield* Effect.sleep("100 millis")
        }

        // The drop lands once the corpse's write queue fills and the offer
        // bound trips — the queue tops up at heartbeat cadence, so give it
        // room and fail with a named message if the bound never fires.
        yield* waitFor(
          "the corpse was never dropped — the write stall bound never tripped",
          () => lines.some((line) => line.startsWith("SSE-DROP")),
          12_000,
        )

        const drops = lines.filter((line) => line.startsWith("SSE-DROP"))
        expect(drops.length).toBe(1)
        expect(drops[0]).toContain("reason=stalled_write")
        // The drop line names the blocked-write signature: the bounded write
        // queue is pinned full (the platform writer stopped draining it) while
        // the events it never consumed kept piling in the connection's event
        // queue.
        expect(drops[0]).toMatch(/since_last_tick_ms=\d+/)
        expect(drops[0]).toMatch(/event_queue_depth=\d+/)
        expect(drops[0]).toContain("write_queue_depth=64")

        // The corpse is forgotten by the registry — the engine-side half of
        // the drop. (The wire-level FIN is the frontdoor slice's end; under
        // bun the engine's destroy cannot reach the peer — see spawnCorpse.)
        expect(telemetry.snapshot().connections).toBe(1)

        // The healthy subscriber sails on: heartbeats keep arriving past the
        // drop, several cadence windows deep.
        const heartbeatsAtDrop = healthy.heartbeats()
        yield* Effect.sleep("1500 millis")
        expect(healthy.isClosed()).toBe(false)
        expect(healthy.heartbeats() - heartbeatsAtDrop).toBeGreaterThanOrEqual(5)

        // Phase A telemetry documents the healthy state through the whole
        // test: ticks keep flowing, the watchdog never declares a stall.
        expect(lines.some((line) => line.startsWith("SELF-STALL"))).toBe(false)
        expect(lines.filter((line) => line.startsWith("SSE-TICK")).length).toBeGreaterThanOrEqual(5)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    30_000,
  )

  it.instance(
    "with a corpse wedged, the recurring emission (Stream.tick + bus fan-out) keeps running and the healthy subscriber is unaffected",
    () =>
      Effect.gen(function* () {
        const lines: Array<string> = []
        const telemetry = makeSseTickTelemetry({
          cadenceMs: 100,
          watchdogIntervalMs: 2_000,
          probeIntervalMs: 500,
          sink: (line) => lines.push(line),
        })
        setSseTickTelemetry(telemetry)

        const { directory } = yield* TestInstance
        const address = yield* sseAddress()
        const healthy = yield* openRawSse(address, directory)
        yield* spawnCorpse(address, directory)
        yield* Effect.addFinalizer(() => Effect.sync(() => healthy.close()))

        // Attribute tick lines per connection by order of first appearance:
        // the healthy subscriber registered first.
        const connIds = () =>
          [...new Set(lines.filter((l) => l.startsWith("SSE-TICK")).map((l) => l.match(/conn=(\S+)/)?.[1]))]
        const lastTickTs = (connId: string) => {
          const ts = lines
            .filter((l) => l.startsWith("SSE-TICK") && l.includes(`conn=${connId}`))
            .map((l) => Number(l.match(/ts_ms=(\d+)/)?.[1]))
          return ts.at(-1)
        }

        // Phase 1 — wedge the corpse (same pump as the corpse test).
        const bigTitle = "x".repeat(65_536)
        const pumpDeadline = Date.now() + 14_000
        for (let i = 0; i < 24 && Date.now() < pumpDeadline; i++) {
          const created = yield* requestInDirectory("/session", directory, {
            method: "POST",
            body: JSON.stringify({ title: `${i}-${bigTitle}` }),
          })
          if (created.status !== 200) break
          yield* Effect.sleep("100 millis")
        }
        const [healthyConn, corpseConn] = connIds()
        expect(healthyConn).toBeDefined()
        expect(corpseConn).toBeDefined()

        // The corpse's write path parks once its bounded write queue fills;
        // from that moment its tick source goes silent (the wedge signature)
        // while the healthy connection keeps ticking at cadence. That is the
        // window this test pins: the recurring emission must keep running
        // through the corpse's wedge.
        yield* waitFor(
          "the corpse's write path never wedged",
          () => {
            const corpseLast = lastTickTs(corpseConn!)
            const healthyLast = lastTickTs(healthyConn!)
            return (
              corpseLast !== undefined &&
              healthyLast !== undefined &&
              Date.now() - corpseLast > 500 &&
              Date.now() - healthyLast < 300
            )
          },
          12_000,
        )
        const healthyTicksAtWedge = lines.filter((l) => l.startsWith("SSE-TICK") && l.includes(`conn=${healthyConn}`)).length
        const healthyEventsAtWedge = healthy.events()

        // Publish a normal event mid-wedge: the bus fan-out must deliver it
        // to the healthy subscriber with the corpse parked on its write.
        const midWedge = yield* requestInDirectory("/session", directory, {
          method: "POST",
          body: JSON.stringify({ title: "mid-wedge" }),
        })
        expect(midWedge.status).toBe(200)
        yield* waitFor("the mid-wedge event never reached the healthy subscriber", () => healthy.events() > healthyEventsAtWedge)

        // Heartbeats kept their cadence to the healthy subscriber through the
        // corpse's wedge.
        yield* Effect.sleep("500 millis")
        const healthyTicksAfterWedge = lines.filter((l) => l.startsWith("SSE-TICK") && l.includes(`conn=${healthyConn}`)).length
        expect(healthyTicksAfterWedge - healthyTicksAtWedge).toBeGreaterThanOrEqual(3)
        expect(lines.some((line) => line.startsWith("SELF-STALL"))).toBe(false)

        // Phase 2 — the drop lands on the corpse (naming it), and the healthy
        // subscriber's stream carries on unaffected: another event arrives,
        // heartbeats keep their cadence, the socket stays open.
        yield* waitFor(
          "the corpse was never dropped — the write stall bound never tripped",
          () => lines.some((line) => line.startsWith("SSE-DROP")),
          12_000,
        )
        const drop = lines.find((line) => line.startsWith("SSE-DROP"))!
        expect(drop).toContain(`conn=${corpseConn}`)
        expect(drop).toContain("reason=stalled_write")

        const healthyEventsAtDrop = healthy.events()
        const postDrop = yield* requestInDirectory("/session", directory, {
          method: "POST",
          body: JSON.stringify({ title: "post-drop" }),
        })
        expect(postDrop.status).toBe(200)
        yield* waitFor("the post-drop event never reached the healthy subscriber", () => healthy.events() > healthyEventsAtDrop)
        const heartbeatsAtDrop = healthy.heartbeats()
        yield* Effect.sleep("1500 millis")
        expect(healthy.isClosed()).toBe(false)
        expect(healthy.heartbeats() - heartbeatsAtDrop).toBeGreaterThanOrEqual(5)
        expect(telemetry.snapshot().connections).toBe(1)
        expect(lines.some((line) => line.startsWith("SELF-STALL"))).toBe(false)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    45_000,
  )
})

// ── #1808: the production stall drill ────────────────────────────────────────
//
// The mute-sink postmortem (the third #1798 occurrence, 2026-10-16 03:27):
// Phase A's lines were perfect under the injected sink and invisible in
// production, so the drill must wedge the tick source through the SAME env
// override ops uses against a real boot — never through the injectable test
// sink — and assert the watchdog names the stall through whatever sink the
// production singleton carries. This suite rides the fast singleton for
// cadence only; the real-process proof (engine binary → runner forward →
// scratch log) is the gate's end-to-end half.
describe("self-stall drill (#1808 — wedged tick source, production wiring)", () => {
  afterEach(() => {
    // bun shares one process across test files — the drill env must not leak.
    delete process.env.AMICODE_SSE_TICK_STALL
    resetSseTickTelemetry()
  })

  it.instance(
    "AMICODE_SSE_TICK_STALL=1 wedges the tick source: no SSE-TICK, no heartbeat on the wire, the watchdog SELF-STALLs",
    () =>
      Effect.gen(function* () {
        const lines: Array<string> = []
        const telemetry = makeSseTickTelemetry({
          cadenceMs: 100,
          watchdogIntervalMs: 300,
          probeIntervalMs: 500,
          sink: (line) => lines.push(line),
        })
        setSseTickTelemetry(telemetry)
        process.env.AMICODE_SSE_TICK_STALL = "1"

        const { directory } = yield* TestInstance
        // Inner scope: the drill's connection lives only as long as the
        // assertions need it live, and its finalizer unregisters against the
        // fast singleton INSIDE the test — bun shares one process across
        // files, so a leaked registration or raw timer must not outlive it.
        yield* Effect.gen(function* () {
          const { response, reader } = yield* openEventStream(directory)
          expect(response.status).toBe(200)
          expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

          // The wedge parks the heartbeat tap BEFORE its first noteTick: no
          // heartbeat frame ever reaches the wire — the silent-recycle shape
          // (connection open, frontdoor cadence telemetry sees zero ticks).
          const frame = yield* Queue.take(reader).pipe(
            Effect.as("frame" as const),
            Effect.timeoutOrElse({ duration: "250 millis", orElse: () => Effect.succeed("silent" as const) }),
          )
          expect(frame).toBe("silent")

          // The out-of-tree watchdog names the stall while the tap fiber
          // sits parked and the connection stays registered: a full check
          // window with zero ticks from the live connection.
          yield* Effect.sleep("700 millis")
          const stalls = lines.filter((line) => line.startsWith("SELF-STALL"))
          expect(stalls.length).toBeGreaterThanOrEqual(1)
          expect(stalls[0]).toContain("seen=0")
          expect(stalls[0]).toContain("route=/event")
          expect(lines.some((line) => line.startsWith("SSE-TICK"))).toBe(false)
        }).pipe(Effect.scoped)

        // The finalizer is async — poll until the registry drains, then stop
        // the drill telemetry's raw timers (watchdog + probe) for good.
        yield* Effect.forEach(
          [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
          () =>
            Effect.gen(function* () {
              if (telemetry.snapshot().connections > 0) yield* Effect.sleep("100 millis")
            }),
          { discard: true },
        )
        expect(telemetry.snapshot().connections).toBe(0)
        telemetry.stop()
      }),
    { git: true, config: { formatter: false, lsp: false } },
    10_000,
  )
})
