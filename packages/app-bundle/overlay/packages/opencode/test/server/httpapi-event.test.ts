import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Queue, Schema, Stream } from "effect"
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
