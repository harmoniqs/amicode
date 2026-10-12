// #1776 — the global event stream is sequenced and replayable: every frame
// carries an `<epoch>:<seq>` SSE id, a resume cursor replays the gap, an
// unservable cursor gets an explicit reset, heartbeats carry time + seq, and a
// client abort releases its subscription. Exercised with a raw fetch client
// (exact headers, real aborts) against the in-process server, which runs on the
// same Bun node:http shim as the compiled binary.
import { NodeHttpServer } from "@effect/platform-node"
import Http from "node:http"
import { describe, expect } from "bun:test"
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
import { testEffect } from "../lib/effect"
import { OUTPUT_THROTTLE_MS, makeOutputThrottle } from "../../src/tool/shell-output-throttle"

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
  if (!match) throw new Error(`frame id ${JSON.stringify(frame.id)} is not <epoch>:<seq> (${JSON.stringify(frame.data)})`)
  return { epoch: match[1], seq: Number(match[2]) }
}

function parseFrame(block: string): Frame {
  const frame: Frame = { id: undefined, event: undefined, data: undefined, raw: "", bytes: Buffer.byteLength(block) + 2 }
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

describe("global event stream — sequenced ids (#1776)", () => {
  it.live("every frame carries an <epoch>:<seq> id shared by all subscribers; a sync copy carries its source's id", () =>
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

describe("global event stream — sync copies are opt-in (#1778)", () => {
  it.live("a default subscriber gets no sync copies and its sequence stays gap-free; an opt-in subscriber gets them all", () =>
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
      expect(typesOf(syncedFrames)).toEqual(["test.first", "test.durable", "sync", "test.durable", "sync", "test.last"])
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
      expect(typesOf(syncedFrames)).toEqual(["test.durable", "sync", "test.between", "test.durable", "sync", "test.live"])
      expect(seqsOf(syncedFrames)).toEqual([1, 1, 2, 3, 3, 4].map((n) => base + n))
    }),
  )

  it.live("a sync copy with no framed source keeps its own sequence and reaches every subscriber, so no hole opens", () =>
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

// A per-turn summary as the engine publishes it: every changed file with its
// full patch text (measured up to 12.3 MB in one event on the Studio).
const summaryDiffs = () => [
  { file: "src/app.ts", patch: "@@ -1,2 +1,3 @@\n-old\n+new\n+more\n", additions: 2, deletions: 1, status: "modified" },
  { file: "src/new.ts", patch: `@@ -0,0 +1,400 @@\n${"+line\n".repeat(400)}`, additions: 400, deletions: 0, status: "added" },
  { file: "src/gone.ts", patch: "@@ -1 +0,0 @@\n-gone\n", additions: 0, deletions: 1, status: "deleted" },
]
const stripped = (diffs: ReturnType<typeof summaryDiffs>) => diffs.map(({ patch: _patch, ...rest }) => rest)

/** A summary-bearing durable event and its sync copy, as the event-v2 bridge emits them. */
const summaryTwin = (id: string, type: "message.updated" | "session.updated") => {
  const info =
    type === "message.updated"
      ? { id: "msg_i1778", sessionID: "ses_i1778", role: "user", summary: { title: "Edit", diffs: summaryDiffs() } }
      : { id: "ses_i1778", title: "Session", summary: { additions: 402, deletions: 2, files: 3, diffs: summaryDiffs() } }
  const properties = { sessionID: "ses_i1778", info }
  const source = { directory: "/tmp/i1778", payload: { id, type, properties } }
  const copy = {
    directory: "/tmp/i1778",
    payload: { type: "sync", syncEvent: { id, type: `${type}.1`, seq: 3, aggregateID: "ses_i1778", data: properties } },
  }
  return { source, copy }
}

describe("global event stream — summary diffs carry no patch bodies on the wire (#1778)", () => {
  for (const type of ["message.updated", "session.updated"] as const) {
    it.live(`a live ${type} keeps file, status and counts but drops patch bodies; the bus payload keeps them`, () =>
      Effect.gen(function* () {
        const plain = yield* connect()
        const synced = yield* connect({ headers: { "x-opencode-sync-copies": "true" } })
        yield* plain.next
        yield* synced.next
        const seen: GlobalEvent[] = []
        const listener = (event: GlobalEvent) => seen.push(event)
        GlobalBus.on("event", listener)
        yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

        const { source, copy } = summaryTwin(`evt_i1778_${type}`, type)
        GlobalBus.emit("event", source)
        GlobalBus.emit("event", copy)

        const live = yield* plain.next
        expect(live.data.payload.type).toBe(type)
        const info = live.data.payload.properties.info
        expect(info.summary.diffs).toEqual(stripped(summaryDiffs()))
        expect(live.raw).not.toContain('"patch"')
        // everything else in the event is as published
        expect({ ...info, summary: { ...info.summary, diffs: undefined } }).toEqual({
          ...source.payload.properties.info,
          summary: { ...source.payload.properties.info.summary, diffs: undefined },
        })
        // the projection is wire-only: in-process subscribers see the full event, untouched
        expect(seen.find((event) => event.payload.type === type)?.payload.properties.info.summary.diffs).toEqual(
          summaryDiffs(),
        )

        // the opt-in subscriber gets the same stripped frame, and a full sync copy
        // (the replica replays it into its own store, so it keeps the patches)
        const [same, sync] = yield* synced.take(2)
        expect(same.raw).toBe(live.raw)
        expect(same.id).toBe(live.id)
        expect(sync.data.payload.type).toBe("sync")
        expect(sync.data.payload.syncEvent.data.info.summary.diffs).toEqual(summaryDiffs())
      }),
    )
  }

  it.live("a replayed summary frame is byte-identical to the live one", () =>
    Effect.gen(function* () {
      const a = yield* connect()
      const cursor = (yield* a.next).id!
      const { source } = summaryTwin("evt_i1778_replayed", "message.updated")
      GlobalBus.emit("event", source)
      const live = yield* a.next
      a.abort()

      const b = yield* connect({ headers: { "last-event-id": cursor } })
      yield* b.next
      const replayed = yield* b.next
      expect(replayed.id).toBe(live.id)
      expect(replayed.raw).toBe(live.raw)
      expect(replayed.raw).not.toContain('"patch"')
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

describe("global event stream — client abort (#1776)", () => {
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

// ── #1778 fixture turn: a multi-file edit plus a chatty shell command ──────────
//
// The same turn, two ways. BEFORE is what #1776's engine put on every
// subscriber's wire: each event serialized whole, each durable event followed by
// its sync copy, one shell preview update per output chunk. AFTER is measured
// on the live wire of a default subscriber of this engine: no sync copies,
// summary patch bodies stripped, shell updates through the real throttle
// (driven by TestClock). Sizes mirror the Studio measurement: one summary of
// 88 files carrying ~2.6 MB of patch text.
const FIXTURE = { files: 88, patchBytes: 30_000, chunks: 300, chunkEveryMs: 10, chunkBytes: 160, deltas: 120 }
const PREVIEW_MAX = 30_000 // the shell tool's MAX_METADATA_LENGTH
const KB = 1024

// the engine's SSE framing (the encoder omits the default `event: message` line)
const sseBytes = (id: string, data: string) => Buffer.byteLength(`id: ${id}\ndata: ${data}\n\n`)

const patchFor = (file: string, bytes: number) => {
  const line = `+  export const value_${file.length} = "${"x".repeat(60)}"\n`
  return `--- a/${file}\n+++ b/${file}\n@@ -1,0 +1,${Math.ceil(bytes / line.length)} @@\n${line.repeat(Math.ceil(bytes / line.length))}`
}

describe("global event stream — fixture turn byte report (#1778)", () => {
  it.effect("a multi-file edit plus a chatty shell command keeps every live frame under 256 KB", () =>
    Effect.gen(function* () {
      const plain = yield* connect()
      yield* plain.next
      const before: { type: string; bytes: number; sync: boolean }[] = []
      let liveEvents = 0
      const base = { directory: "/tmp/i1778-fixture", project: "prj_i1778" }
      const sessionID = "ses_i1778_fixture"

      // Emit like the event-v2 bridge (the event, then for a durable one its sync
      // copy) and record the frame #1776's tap would have serialized for each.
      const publish = (type: string, properties: Record<string, unknown>, options: { durable?: boolean; record?: boolean } = {}) => {
        const id = `evt_i1778_fx_${GlobalBus.seq + 1}`
        const event = { ...base, payload: { id, type, properties } }
        GlobalBus.emit("event", event)
        liveEvents++
        const record = options.record !== false
        if (record) before.push({ type, sync: false, bytes: sseBytes(`${GlobalBus.epoch}:${GlobalBus.seq}`, JSON.stringify(event)) })
        if (options.durable === false) return
        const copy = {
          ...base,
          payload: { type: "sync", syncEvent: { id, type: `${type}.1`, seq: before.length, aggregateID: sessionID, data: properties } },
        }
        GlobalBus.emit("event", copy)
        if (record) before.push({ type, sync: true, bytes: sseBytes(`${GlobalBus.epoch}:${GlobalBus.seq}`, JSON.stringify(copy)) })
      }
      const user = { id: "msg_i1778_user", sessionID, role: "user", time: { created: 1 }, agent: "build", model: { providerID: "p", modelID: "m" } }
      const assistant = { id: "msg_i1778_asst", sessionID, role: "assistant", parentID: user.id, time: { created: 2 } }
      const tool = (callID: string, toolName: string, state: Record<string, unknown>) => ({
        sessionID,
        part: { id: `prt_${callID}`, sessionID, messageID: assistant.id, type: "tool", callID, tool: toolName, state },
        time: 3,
      })

      publish("message.updated", { sessionID, info: user })
      publish("message.updated", { sessionID, info: assistant })
      for (let i = 0; i < FIXTURE.deltas; i++)
        publish("message.part.delta", { sessionID, messageID: assistant.id, partID: "prt_text", field: "text", delta: "Editing the module now. " }, { durable: false })

      // the multi-file edit: each edit tool part runs then completes (its own
      // metadata keeps its patch — other tools' metadata is out of scope)
      const files = Array.from({ length: FIXTURE.files }, (_, i) => `packages/app/src/feature/module-${i}.ts`)
      const diffs = files.map((file) => ({ file, patch: patchFor(file, FIXTURE.patchBytes), additions: 400, deletions: 12, status: "modified" }))
      for (const [i, diff] of diffs.entries()) {
        const input = { filePath: diff.file, oldString: "a", newString: "b" }
        publish("message.part.updated", tool(`edit_${i}`, "edit", { status: "pending", input, raw: "" }))
        const filediff = { file: diff.file, patch: diff.patch, additions: diff.additions, deletions: diff.deletions }
        publish(
          "message.part.updated",
          tool(`edit_${i}`, "edit", {
            status: "completed",
            input,
            output: "Edit applied successfully.",
            title: diff.file,
            metadata: { diff: diff.patch, filediff, diagnostics: {} },
            time: { start: 3, end: 4 },
          }),
        )
      }

      // the chatty shell command: a running update per output chunk BEFORE, the
      // throttled updates AFTER (first at once, <= 1 per 200 ms, final flush)
      const command = { command: "bun run build --verbose" }
      const running = (output: string) => tool("shell_0", "bash", { status: "running", input: command, metadata: { output }, time: { start: 5 } })
      const previews: string[] = []
      let output = ""
      for (let i = 0; i < FIXTURE.chunks; i++) {
        output += `[build] step ${String(i).padStart(4, "0")} ${"·".repeat(FIXTURE.chunkBytes - 24)}\n`
        previews.push(output.length <= PREVIEW_MAX ? output : "...\n\n" + output.slice(-PREVIEW_MAX))
      }
      // BEFORE: one running update (and its sync copy) per output chunk
      const frameBytes = (payload: Record<string, unknown>) =>
        sseBytes(`${GlobalBus.epoch}:${GlobalBus.seq + 1}`, JSON.stringify({ ...base, payload }))
      for (const preview of previews) {
        const id = `evt_i1778_fx_shell_${before.length}`
        const data = running(preview)
        before.push({ type: "shell", sync: false, bytes: frameBytes({ id, type: "message.part.updated", properties: data }) })
        before.push({
          type: "shell",
          sync: true,
          bytes: frameBytes({ id, type: "sync", syncEvent: { id, type: "message.part.updated.1", seq: 0, aggregateID: sessionID, data } }),
        })
      }
      // AFTER: the same chunks, 10 ms apart, through the shell tool's throttle
      let shellUpdates = 0
      const throttle = yield* makeOutputThrottle((preview) =>
        Effect.sync(() => {
          shellUpdates++
          publish("message.part.updated", running(preview), { record: false })
        }),
      )
      for (const preview of previews) {
        yield* throttle.offer(preview)
        yield* TestClock.adjust(`${FIXTURE.chunkEveryMs} millis`)
      }
      yield* throttle.flush
      publish("message.part.updated", tool("shell_0", "bash", { status: "completed", input: command, output: previews.at(-1), title: command.command, metadata: { output: previews.at(-1), exit: 0 }, time: { start: 5, end: 6 } }))

      // the per-turn summary: every changed file with its full patch
      publish("message.updated", { sessionID, info: { ...user, summary: { title: "Edit 88 modules", diffs } } })
      publish("session.updated", { sessionID, info: { id: sessionID, title: "fixture", summary: { additions: 400 * 88, deletions: 12 * 88, files: 88 } } })

      const frames = yield* plain.take(liveEvents)
      // the wire carries exactly the turn's events — no sync copy, no hole
      expect(frames.filter((f) => f.data.payload.type === "sync")).toEqual([])
      expect(seqsOf(frames)).toEqual(frames.map((_, i) => seqsOf(frames)[0] + i))
      // the BEFORE formula is the wire's own framing
      for (const frame of frames) expect(sseBytes(frame.id!, frame.raw)).toBe(frame.bytes)

      const after = frames.map((frame) => ({ type: frame.data.payload.type as string, bytes: frame.bytes }))
      const total = (rows: { bytes: number }[]) => rows.reduce((sum, row) => sum + row.bytes, 0)
      const largest = (rows: { bytes: number }[]) => Math.max(...rows.map((row) => row.bytes))
      const summaryAfter = frames.find((f) => f.data.payload.properties?.info?.summary?.diffs)!
      const report = {
        before: { frames: before.length, totalBytes: total(before), largestFrameBytes: largest(before), syncCopies: before.filter((r) => r.sync).length, shellUpdates: previews.length },
        after: { frames: after.length, totalBytes: total(after), largestFrameBytes: largest(after), syncCopies: 0, shellUpdates },
        summaryFrame: { beforeBytes: before.filter((r) => r.type === "message.updated" && !r.sync).at(-1)!.bytes, afterBytes: summaryAfter.bytes },
      }
      console.log(`[#1778 fixture-turn byte report] ${JSON.stringify(report)}`)
      console.log(
        `[#1778 fixture-turn byte report] total ${(report.before.totalBytes / KB / KB).toFixed(2)} MiB -> ${(report.after.totalBytes / KB / KB).toFixed(2)} MiB` +
          ` (${(100 * (1 - report.after.totalBytes / report.before.totalBytes)).toFixed(1)}% cut); largest frame ${(report.before.largestFrameBytes / KB).toFixed(1)} KiB -> ${(report.after.largestFrameBytes / KB).toFixed(1)} KiB;` +
          ` frames ${report.before.frames} -> ${report.after.frames}; shell updates ${report.before.shellUpdates} -> ${report.after.shellUpdates}`,
      )

      expect(report.before.largestFrameBytes).toBeGreaterThan(256 * KB) // the fixture is honest: BEFORE breaks the bound
      expect(report.after.largestFrameBytes).toBeLessThan(256 * KB)
      expect(report.after.totalBytes).toBeLessThan(report.before.totalBytes)
      expect(shellUpdates).toBeLessThanOrEqual(1 + (FIXTURE.chunks * FIXTURE.chunkEveryMs) / OUTPUT_THROTTLE_MS + 1)
      // the final shell output reached the wire before completion
      const lastRunning = frames.filter((f) => f.data.payload.properties?.part?.state?.status === "running").at(-1)!
      expect(lastRunning.data.payload.properties.part.state.metadata.output).toBe(previews.at(-1))
    }),
  )
})
