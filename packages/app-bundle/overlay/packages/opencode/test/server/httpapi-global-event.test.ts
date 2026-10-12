// #1776 — the global event stream is sequenced and replayable: every frame
// carries an `<epoch>:<seq>` SSE id, a resume cursor replays the gap, an
// unservable cursor gets an explicit reset, heartbeats carry time + seq, and a
// client abort releases its subscription. Exercised through a raw node:http
// client against the in-process server (so headers and aborts are exact), on
// the same Bun node:http shim the compiled binary runs on.
import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import http from "node:http"
import { Clock, Context, Effect, Fiber, Layer, Option, Queue, Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../src/auth"
import { GlobalBus } from "../../src/bus/global"
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
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(Layer.mock(Installation.Service)({})),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
)
const it = testEffect(apiLayer)

const ID = /^([A-Za-z0-9_-]+):(\d+)$/

type Frame = { id: string | undefined; event: string | undefined; data: any }

/** Split an SSE id into its epoch and sequence (fails the test if malformed). */
function idOf(frame: Frame) {
  const match = ID.exec(frame.id ?? "")
  if (!match) throw new Error(`frame id ${JSON.stringify(frame.id)} is not <epoch>:<seq> (${JSON.stringify(frame.data)})`)
  return { epoch: match[1], seq: Number(match[2]) }
}

function parseFrame(block: string): Frame {
  const frame: Frame = { id: undefined, event: undefined, data: undefined }
  const data: string[] = []
  for (const line of block.split("\n")) {
    if (line.startsWith("id: ")) frame.id = line.slice(4)
    else if (line.startsWith("event: ")) frame.event = line.slice(7)
    else if (line.startsWith("data: ")) data.push(line.slice(6))
  }
  frame.data = data.length ? JSON.parse(data.join("\n")) : undefined
  return frame
}

/** Open a raw SSE connection to the in-process server's global stream. */
const connect = (input: { headers?: Record<string, string>; query?: string } = {}) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer
    const address = server.address
    if (address._tag !== "TcpAddress") throw new Error("expected a TCP test server")
    const frames = yield* Queue.unbounded<Frame>()
    const request = yield* Effect.callback<http.ClientRequest, Error>((resume) => {
      const req = http.get(
        {
          host: "127.0.0.1",
          port: address.port,
          path: GlobalPaths.event + (input.query ?? ""),
          headers: { accept: "text/event-stream", ...input.headers },
        },
        (res) => {
          let buffer = ""
          res.setEncoding("utf8")
          res.on("data", (chunk: string) => {
            buffer += chunk
            let end = buffer.indexOf("\n\n")
            while (end !== -1) {
              const block = buffer.slice(0, end)
              buffer = buffer.slice(end + 2)
              if (block.trim() !== "") Queue.offerUnsafe(frames, parseFrame(block))
              end = buffer.indexOf("\n\n")
            }
          })
          res.on("error", () => {})
          resume(Effect.succeed(req))
        },
      )
      req.on("error", (error) => resume(Effect.fail(error)))
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => request.destroy()))
    const next = Queue.take(frames).pipe(
      Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(new Error("timed out waiting for frame")) }),
    )
    const take = (n: number) => Effect.forEach(Array.from({ length: n }), () => next)
    return { next, take, abort: () => request.destroy() }
  })

const emit = (type: string, properties: Record<string, unknown> = {}) =>
  GlobalBus.emit("event", { directory: "/tmp/i1776", payload: { type, properties } })

describe("global event stream — sequenced ids (#1776)", () => {
  it.live("every frame carries an <epoch>:<seq> id shared by all subscribers; a sync copy carries its source's id", () =>
    Effect.gen(function* () {
      const a = yield* connect()
      const b = yield* connect()
      const connectedA = yield* a.next
      const connectedB = yield* b.next
      expect(connectedA.data.payload.type).toBe("server.connected")
      const start = idOf(connectedA)
      expect(idOf(connectedB)).toEqual(start)

      emit("test.first")
      // the event-v2 bridge's twin emission: the durable event, then its sync copy
      GlobalBus.emit("event", { directory: "/tmp/i1776", payload: { id: "evt_i1776_durable", type: "test.durable", properties: {} } })
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

describe("global event stream — resume from a cursor (#1776)", () => {
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
          carrier === "Last-Event-ID header" ? { headers: { "last-event-id": one.id! } } : { query: `?lastEventID=${encodeURIComponent(one.id!)}` }
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
        expect(frames.filter((f) => f.data.payload.type === "test.inflight").map((f) => f.data.payload.properties.i)).toEqual(
          Array.from({ length: 20 }, (_, i) => i),
        )
        // nothing further: no duplicate trails the live frames
        const extra = yield* b.next.pipe(Effect.timeoutOrElse({ duration: "200 millis", orElse: () => Effect.succeed(undefined) }))
        expect(extra).toBeUndefined()
      }),
    )
  }
})

describe("global event stream — unservable cursor resets (#1776)", () => {
  const unservable: Record<string, () => Effect.Effect<string, Error, HttpServer.HttpServer | Scope.Scope>> = {
    "a cursor from another epoch": () => Effect.succeed(`x${GlobalBus.epoch}:1`),
    "a cursor that is not <epoch>:<seq> (a payload id)": () => Effect.succeed("evt_131b06142001C9nKEJ5DvEnx4G"),
    "a cursor ahead of the stream": () => Effect.succeed(`${GlobalBus.epoch}:${GlobalBus.seq + 1000}`),
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

describe("global event stream — heartbeats (#1776)", () => {
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
