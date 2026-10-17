// #1776 (ported, #1806 P1a) — the global event stream is sequenced and
// replayable: every frame carries an `<epoch>:<seq>` SSE id, a resume cursor
// replays the gap, an unservable cursor gets an explicit reset, heartbeats
// carry time + seq, a client abort releases its subscription, and the lane's
// bounded-write + tick-telemetry machinery covers the route (SSE-TICK lines
// flow, a stalled write drops, never SELF-STALLs). Sync copies are opt-in per
// subscription (#1778's subscription flag rides with the port; main's
// patch-body wire cuts are P3 and stay out).
//
// Lane adaptation vs main's suite: a cursor that is not `<epoch>:<seq>` (the
// lane's client tracks payload ids) resolves against retained frames instead
// of resetting — wire compatibility requires the existing client's cursors
// to keep being served losslessly.
import { NodeHttpServer } from "@effect/platform-node"
import Http from "node:http"
import { afterEach, describe, expect } from "bun:test"
import { Clock, Context, Effect, Fiber, Layer, Logger, Option, Queue, References, Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../src/auth"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { GlobalEventReplay } from "../../src/bus/global-replay"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { resetSseTickTelemetry, setSseTickTelemetry, makeSseTickTelemetry } from "../../src/server/shared/sse-tick-telemetry"
import { testEffect } from "../lib/effect"

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // Raw HttpApi routes expose an opaque handler context at the request boundary.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  // Bound to 127.0.0.1 — the address the raw fetch client dials — not
  // `NodeHttpServer.layerTest`'s wildcard. The kernel only skips ephemeral ports
  // already bound on the SAME address, so a wildcard bind can share its port
  // with another process's 127.0.0.1 listener, which then answers our requests.
  Layer.provideMerge(NodeHttpServer.layer(Http.createServer, { host: "127.0.0.1", port: 0 })),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(Layer.mock(Installation.Service)({})),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
  Layer.provide(
    Logger.layer([
      Logger.make<unknown, void>((options) => {
        logs.push({
          message: ([] as unknown[]).concat(options.message).join(" "),
          annotations: { ...options.fiber.getRef(References.CurrentLogAnnotations) },
        })
      }),
    ]),
  ),
)
const it = testEffect(apiLayer)

// The server's own log lines (the stream's connect/disconnect census).
const logs: { message: string; annotations: Record<string, unknown> }[] = []
const logged = (message: string) => logs.filter((line) => line.message === message)

/** Poll until `probe` holds (true), or give up after `ms` (false). */
const eventually = (probe: () => boolean, ms = 3_000) =>
  Effect.gen(function* () {
    while (!probe()) yield* Effect.sleep("20 millis")
    return true
  }).pipe(Effect.timeoutOrElse({ duration: ms, orElse: () => Effect.succeed(false) }))

const ID = /^([A-Za-z0-9_-]+):(\d+)$/

/** One SSE frame; `raw` is its `data` exactly as sent, `bytes` the whole frame on the wire. */
type Frame = { id: string | undefined; event: string | undefined; data: any; raw: string; bytes: number }

/** Split an SSE id into its epoch and sequence (fails the test if malformed). */
function idOf(frame: Frame) {
  const match = ID.exec(frame.id ?? "")
  if (!match)
    throw new Error(`frame id ${JSON.stringify(frame.id)} is not <epoch>:<seq> (${JSON.stringify(frame.data)})`)
  return { epoch: match[1], seq: Number(match[2]) }
}

function parseFrame(block: string): Frame {
  const frame: Frame = {
    id: undefined,
    event: undefined,
    data: undefined,
    raw: "",
    bytes: Buffer.byteLength(block) + 2,
  }
  const data: string[] = []
  for (const line of block.split("\n")) {
    if (line.startsWith("id: ")) frame.id = line.slice(4)
    else if (line.startsWith("event: ")) frame.event = line.slice(7)
    else if (line.startsWith("data: ")) data.push(line.slice(6))
  }
  frame.raw = data.join("\n")
  frame.data = data.length ? JSON.parse(frame.raw) : undefined
  return frame
}

/** Open a raw SSE connection to the in-process server's global stream. */
const connect = (input: { headers?: Record<string, string>; query?: string } = {}) =>
  Effect.gen(function* () {
    // The router is attached while the layer builds, so the server routes from
    // the first request; dial exactly the address it is bound to.
    const url = HttpServer.formatAddress((yield* HttpServer.HttpServer).address)
    const frames = yield* Queue.unbounded<Frame>()
    const seen: string[] = []
    let ended = ""
    const controller = new AbortController()
    const response = yield* Effect.promise(() =>
      fetch(`${url}${GlobalPaths.event}${input.query ?? ""}`, {
        headers: { accept: "text/event-stream", ...input.headers },
        signal: controller.signal,
      }),
    )
    const status = `${response.status} ${response.headers.get("content-type") ?? "-"}`
    // Read the body in the background, splitting it into SSE frames.
    void (async () => {
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ""
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) return
        buffer += chunk.value
        for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          if (block.trim() === "") continue
          const frame = parseFrame(block)
          seen.push(`${frame.id}=${frame.data?.payload?.type}`)
          Queue.offerUnsafe(frames, frame)
        }
      }
    })().then(
      () => (ended ||= `end (${status})`),
      (error) => (ended ||= `${error?.name ?? "error"} (${status})`),
    )
    const abort = () => controller.abort()
    yield* Effect.addFinalizer(() => Effect.sync(abort))
    const next = Queue.take(frames).pipe(
      Effect.timeoutOrElse({
        duration: "4 seconds",
        orElse: () =>
          Effect.fail(new Error(`timed out waiting for frame; seen [${seen.join(", ")}], response ${ended || "open"}`)),
      }),
    )
    const take = (n: number) => Effect.forEach(Array.from({ length: n }), () => next)
    return { next, take, abort }
  })

const emit = (type: string, properties: Record<string, unknown> = {}) =>
  GlobalBus.emit("event", { directory: "/tmp/i1776", payload: { type, properties } })

/** The event-v2 bridge's twin emission: a durable event, then its sync copy. */
const twin = (id: string, type = "test.durable") => {
  GlobalBus.emit("event", { directory: "/tmp/i1778", payload: { id, type, properties: {} } })
  GlobalBus.emit("event", {
    directory: "/tmp/i1778",
    payload: { type: "sync", syncEvent: { id, type: `${type}.1`, seq: 1, aggregateID: "agg", data: {} } },
  })
}

const typesOf = (frames: Frame[]) => frames.map((frame) => frame.data.payload.type)
const seqsOf = (frames: Frame[]) => frames.map((frame) => idOf(frame).seq)
/** Resolves `undefined` when no further frame arrives within `ms`. */
const quiet = (stream: { next: Effect.Effect<Frame, Error> }, ms = 200) =>
  stream.next.pipe(Effect.timeoutOrElse({ duration: ms, orElse: () => Effect.succeed(undefined) }))

describe("global event stream — sequenced ids (#1776 port)", () => {
  it.live(
    "every frame carries an <epoch>:<seq> id shared by all subscribers; a sync copy carries its source's id",
    () =>
      Effect.gen(function* () {
        // sync copies are opt-in (#1778): both subscribers request them
        const a = yield* connect({ query: "?sync=true" })
        const b = yield* connect({ query: "?sync=true" })
        const connectedA = yield* a.next
        const connectedB = yield* b.next
        expect(connectedA.data.payload.type).toBe("server.connected")
        const start = idOf(connectedA)
        expect(idOf(connectedB)).toEqual(start)

        emit("test.first")
        // the event-v2 bridge's twin emission: the durable event, then its sync copy
        GlobalBus.emit("event", {
          directory: "/tmp/i1776",
          payload: { id: "evt_i1776_durable", type: "test.durable", properties: {} },
        })
        GlobalBus.emit("event", {
          directory: "/tmp/i1776",
          payload: {
            type: "sync",
            syncEvent: { id: "evt_i1776_durable", type: "test.durable.1", seq: 1, aggregateID: "agg", data: {} },
          },
        })
        emit("test.last")

        const framesA = yield* a.take(4)
        const framesB = yield* b.take(4)
        expect(framesA.map((f) => f.data.payload.type)).toEqual(["test.first", "test.durable", "sync", "test.last"])
        expect(framesA.map((f) => f.id)).toEqual(framesB.map((f) => f.id))
        const seqs = framesA.map((f) => idOf(f).seq)
        expect(framesA.every((f) => idOf(f).epoch === start.epoch)).toBe(true)
        expect(seqs).toEqual([start.seq + 1, start.seq + 2, start.seq + 2, start.seq + 3])
      }),
  )
})

describe("global event stream — sync copies are opt-in (#1778 subscription flag)", () => {
  it.live(
    "a default subscriber gets no sync copies and its sequence stays gap-free; an opt-in subscriber gets them all",
    () =>
      Effect.gen(function* () {
        const plain = yield* connect()
        // the header carrier (what the workspace control plane sends); `?sync=true` is the query twin
        const synced = yield* connect({ headers: { "x-opencode-sync-copies": "true" } })
        const start = idOf(yield* plain.next)
        expect(idOf(yield* synced.next)).toEqual(start)

        emit("test.first")
        twin("evt_i1778_optin_a")
        twin("evt_i1778_optin_b")
        emit("test.last")

        const plainFrames = yield* plain.take(4)
        expect(typesOf(plainFrames)).toEqual(["test.first", "test.durable", "test.durable", "test.last"])
        // filtering the copies punches no hole: a copy shares its source's sequence
        expect(seqsOf(plainFrames)).toEqual([1, 2, 3, 4].map((n) => start.seq + n))
        expect(yield* quiet(plain)).toBeUndefined()

        const syncedFrames = yield* synced.take(6)
        expect(typesOf(syncedFrames)).toEqual([
          "test.first",
          "test.durable",
          "sync",
          "test.durable",
          "sync",
          "test.last",
        ])
        expect(seqsOf(syncedFrames)).toEqual([1, 2, 2, 3, 3, 4].map((n) => start.seq + n))
        // the frames both subscribers get are the same frames
        expect(syncedFrames.filter((f) => f.data.payload.type !== "sync").map((f) => f.id)).toEqual(
          plainFrames.map((f) => f.id),
        )
      }),
  )

  it.live("a resumed connection replays sync copies only when it requests them", () =>
    Effect.gen(function* () {
      const a = yield* connect()
      const cursor = (yield* a.next).id!
      a.abort()
      twin("evt_i1778_replay_a")
      emit("test.between")
      twin("evt_i1778_replay_b")

      const plain = yield* connect({ headers: { "last-event-id": cursor } })
      const synced = yield* connect({ headers: { "last-event-id": cursor }, query: "?sync=true" })
      const base = idOf(yield* plain.next).seq
      yield* synced.next
      emit("test.live")

      const plainFrames = yield* plain.take(4)
      expect(typesOf(plainFrames)).toEqual(["test.durable", "test.between", "test.durable", "test.live"])
      expect(seqsOf(plainFrames)).toEqual([1, 2, 3, 4].map((n) => base + n))
      expect(yield* quiet(plain)).toBeUndefined()

      const syncedFrames = yield* synced.take(6)
      expect(typesOf(syncedFrames)).toEqual([
        "test.durable",
        "sync",
        "test.between",
        "test.durable",
        "sync",
        "test.live",
      ])
      expect(seqsOf(syncedFrames)).toEqual([1, 1, 2, 3, 3, 4].map((n) => base + n))
    }),
  )

  it.live(
    "a sync copy with no framed source keeps its own sequence and reaches every subscriber, so no hole opens",
    () =>
      Effect.gen(function* () {
        const plain = yield* connect()
        const start = idOf(yield* plain.next)
        emit("test.before")
        GlobalBus.emit("event", {
          directory: "/tmp/i1778",
          payload: {
            type: "sync",
            syncEvent: { id: "evt_i1778_orphan", type: "test.orphan.1", seq: 1, aggregateID: "agg", data: {} },
          },
        })
        emit("test.after")
        const frames = yield* plain.take(3)
        expect(typesOf(frames)).toEqual(["test.before", "sync", "test.after"])
        expect(seqsOf(frames)).toEqual([1, 2, 3].map((n) => start.seq + n))
      }),
  )
})

describe("global event stream — resume from a cursor (#1776 port)", () => {
  for (const carrier of ["Last-Event-ID header", "lastEventID query"] as const) {
    it.live(`replays exactly the frames after a ${carrier} cursor, then continues live`, () =>
      Effect.gen(function* () {
        const a = yield* connect()
        yield* a.next
        emit("test.one")
        emit("test.two")
        emit("test.three")
        const [one] = yield* a.take(3)
        const cursor = idOf(one)
        a.abort()

        emit("test.gap")
        const resume =
          carrier === "Last-Event-ID header"
            ? { headers: { "last-event-id": one.id! } }
            : { query: `?lastEventID=${encodeURIComponent(one.id!)}` }
        // events keep arriving while the reconnect is in flight
        const reconnect = yield* Effect.forkChild(connect(resume))
        for (let i = 0; i < 20; i++) {
          emit("test.inflight", { i })
          yield* Effect.sleep("1 millis")
        }
        const b = yield* Fiber.join(reconnect)
        emit("test.after")

        const connected = yield* b.next
        expect(connected.data.payload.type).toBe("server.connected")
        expect(idOf(connected)).toEqual(cursor)
        const frames = yield* b.take(2 + 1 + 20 + 1)
        const types = frames.map((f) => f.data.payload.type)
        expect(types).toEqual(["test.two", "test.three", "test.gap", ...Array(20).fill("test.inflight"), "test.after"])
        expect(frames.map((f) => idOf(f).seq)).toEqual(Array.from({ length: 24 }, (_, i) => cursor.seq + 1 + i))
        expect(
          frames.filter((f) => f.data.payload.type === "test.inflight").map((f) => f.data.payload.properties.i),
        ).toEqual(Array.from({ length: 20 }, (_, i) => i))
        // nothing further: no duplicate trails the live frames
        const extra = yield* b.next.pipe(
          Effect.timeoutOrElse({ duration: "200 millis", orElse: () => Effect.succeed(undefined) }),
        )
        expect(extra).toBeUndefined()
      }),
    )
  }

  it.live(
    "a legacy payload-id cursor (the lane's client vocabulary) resolves leniently and replays the gap",
    () =>
      Effect.gen(function* () {
        const a = yield* connect()
        const connected = yield* a.next
        expect(connected.data.payload.type).toBe("server.connected")
        GlobalBus.emit("event", { directory: "/tmp/i1776", payload: { id: "evt_p1a_leg_1", type: "test.leg.a", properties: {} } })
        GlobalBus.emit("event", { directory: "/tmp/i1776", payload: { id: "evt_p1a_leg_2", type: "test.leg.b", properties: {} } })
        const second = yield* a.next
        expect(second.data.payload.type).toBe("test.leg.a")

        // the lane's client sends the last payload id it applied — not the SSE id
        const b = yield* connect({ query: `?lastEventID=${encodeURIComponent("evt_p1a_leg_1")}` })
        const bConnected = yield* b.next
        expect(bConnected.data.payload.type).toBe("server.connected")
        expect(bConnected.data.payload.type).not.toBe("server.cursor.unservable")
        const replayed = yield* b.next
        expect(replayed.data.payload.type).toBe("test.leg.b")
        expect(yield* quiet(b)).toBeUndefined()
      }),
  )
})

describe("global event stream — unservable cursor resets (#1776 port)", () => {
  const unservable: Record<string, () => Effect.Effect<string, Error, HttpServer.HttpServer | Scope.Scope>> = {
    "a cursor from another epoch": () => Effect.succeed(`x${GlobalBus.epoch}:1`),
    "a cursor ahead of the stream": () => Effect.succeed(`${GlobalBus.epoch}:${GlobalBus.seq + 1000}`),
    "a cursor below every retained payload id (garbage the history cannot cover)": () =>
      Effect.succeed("aaa"),
    "a cursor older than the buffer's oldest entry": () =>
      Effect.gen(function* () {
        const a = yield* connect()
        const cursor = (yield* a.next).id!
        a.abort()
        // more than the default 32 MiB byte bound: the frames after the cursor are evicted
        const big = "x".repeat(1024 * 1024)
        for (let i = 0; i < 33; i++) emit("test.big", { big })
        return cursor
      }),
  }
  for (const [name, cursorFor] of Object.entries(unservable)) {
    it.live(`${name} yields a reset frame first, then live frames`, () =>
      Effect.gen(function* () {
        emit("test.before")
        const cursor = yield* cursorFor()
        const b = yield* connect({ headers: { "last-event-id": cursor } })
        const current = { epoch: GlobalBus.epoch, seq: GlobalBus.seq }

        const reset = yield* b.next
        expect(reset.data.payload.type).toBe("server.cursor.unservable")
        expect(reset.data.payload.properties).toEqual(current)
        expect(idOf(reset)).toEqual(current)
        const connected = yield* b.next
        expect(connected.data.payload.type).toBe("server.connected")
        expect(idOf(connected)).toEqual(current)

        emit("test.live")
        const live = yield* b.next
        expect(live.data.payload.type).toBe("test.live")
        expect(idOf(live)).toEqual({ epoch: current.epoch, seq: current.seq + 1 })
      }),
    )
  }
})

describe("global event stream — heartbeats (#1776 port)", () => {
  it.effect("a heartbeat carries server time in milliseconds and the current sequence, and ids itself with it", () =>
    Effect.gen(function* () {
      const a = yield* connect()
      yield* a.next
      emit("test.beat")
      const live = yield* a.next

      yield* TestClock.adjust("10 seconds")
      const beat = yield* a.next
      expect(beat.data.payload.type).toBe("server.heartbeat")
      expect(beat.data.payload.properties).toEqual({ time: yield* Clock.currentTimeMillis, seq: idOf(live).seq })
      expect(idOf(beat)).toEqual(idOf(live))

      emit("test.after-beat")
      yield* TestClock.adjust("10 seconds")
      const [after, second] = yield* a.take(2)
      expect(after.data.payload.type).toBe("test.after-beat")
      expect(second.data.payload.type).toBe("server.heartbeat")
      expect(second.data.payload.properties).toEqual({ time: yield* Clock.currentTimeMillis, seq: idOf(after).seq })
      expect(idOf(second)).toEqual(idOf(after))
    }),
  )
})

describe("global event stream — client abort (#1776 port)", () => {
  it.live("a client that disconnects mid-stream releases its subscription and logs the disconnect", () =>
    Effect.gen(function* () {
      // earlier tests' connections (destroyed at their end) finish releasing first
      const settled = () => logged("global event connected").length === logged("global event disconnected").length
      expect(yield* eventually(settled)).toBe(true)
      const baseline = GlobalEventReplay.subscribers
      const disconnects = logged("global event disconnected").length
      const a = yield* connect()
      yield* a.next
      expect(GlobalEventReplay.subscribers).toBe(baseline + 1)
      expect(logged("global event connected").at(-1)?.annotations).toMatchObject({ subscribers: baseline + 1 })

      emit("test.unread")
      emit("test.unread")
      a.abort()

      expect(yield* eventually(() => GlobalEventReplay.subscribers === baseline)).toBe(true)
      const lines = logged("global event disconnected").slice(disconnects)
      expect(lines).toHaveLength(1)
      expect(lines[0].annotations).toMatchObject({ subscribers: baseline })

      // released for good: later events are queued for no one
      for (let i = 0; i < 100; i++) emit("test.after-abort", { i })
      expect(GlobalEventReplay.subscribers).toBe(baseline)
    }),
  )
})

describe("global event stream — lane liveness machinery composes (#1798/#1804)", () => {
  afterEach(() => {
    resetSseTickTelemetry()
  })

  it.live("the route heartbeats at the telemetry cadence and logs an SSE-TICK line per tick; never SELF-STALLs", () =>
    Effect.gen(function* () {
      const lines: Array<string> = []
      const telemetry = makeSseTickTelemetry({
        cadenceMs: 100,
        watchdogIntervalMs: 250,
        probeIntervalMs: 500,
        sink: (line) => lines.push(line),
      })
      setSseTickTelemetry(telemetry)

      const a = yield* connect()
      yield* a.next
      emit("test.tick-source")

      // At the fast test cadence the next frames are the event, then heartbeats.
      const live = yield* a.next
      expect(live.data.payload.type).toBe("test.tick-source")
      const beat = yield* a.next
      expect(beat.data.payload.type).toBe("server.heartbeat")

      const tickLines = lines.filter((line) => line.startsWith("SSE-TICK"))
      expect(tickLines.length).toBeGreaterThanOrEqual(1)
      // queue_depth here is the honest backlog at tick time: the global
      // heartbeat offers its control frame into the event queue, so the tick
      // may see one undelivered beat — the /event route emits the frame as a
      // stream element and reads 0. The line's structure is the contract.
      expect(tickLines[0]).toMatch(
        /^SSE-TICK route=\/global\/event conn=\S+ cadence_ms=100 queue_depth=\d+ fiber=\d+ lag_ms=\d+ rss_bytes=\d+ ts_ms=\d+$/,
      )
      expect(telemetry.snapshot().connections).toBe(1)

      // The stream ends (test scope) → the registry drains → the watchdog stays quiet.
      a.abort()
      expect(yield* eventually(() => telemetry.snapshot().connections === 0)).toBe(true)
      yield* Effect.sleep("600 millis")
      expect(lines.some((line) => line.startsWith("SELF-STALL"))).toBe(false)
    }),
  )
})

// The lane keeps one observable the port must not lose: a `GlobalEvent` read
// through the buffer is the emitted object (the instance route projects the
// payload view from it without re-parsing the wire serialization).
describe("global event replay buffer — frame carries the event (#1806 lane adaptation)", () => {
  it.live("a pushed frame keeps the original event for in-process subscribers", () =>
    Effect.gen(function* () {
      const a = yield* connect()
      yield* a.next
      const event: GlobalEvent = {
        directory: "/tmp/i1776",
        payload: { id: "evt_p1a_frame_event", type: "test.frame.event", properties: { marker: true } },
      }
      GlobalBus.emit("event", event)
      const frame = yield* a.next
      expect(frame.data.payload.type).toBe("test.frame.event")
      expect(frame.data).toEqual(event)
      a.abort()
    }),
  )
})
