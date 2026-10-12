// #1776 — the global event stream is sequenced and replayable: every frame
// carries an `<epoch>:<seq>` SSE id, a resume cursor replays the gap, an
// unservable cursor gets an explicit reset, heartbeats carry time + seq, and a
// client abort releases its subscription. Exercised through a raw node:http
// client against the in-process server (so headers and aborts are exact), on
// the same Bun node:http shim the compiled binary runs on.
import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import http from "node:http"
import { Context, Effect, Layer, Option, Queue } from "effect"
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
