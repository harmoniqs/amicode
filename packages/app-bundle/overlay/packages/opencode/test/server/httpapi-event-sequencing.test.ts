// #1806 P1a (ported onto #1264/#1798 machinery) — the instance /event route
// now stamps its SSE id line with the bus's `<epoch>:<seq>`: a new-vocabulary
// cursor replays the gap through the shared buffer, an unservable cursor gets
// the lane's explicit reset sentinel (`state.resync`), and the client's
// existing payload-id cursors keep being served (no client change rides with
// the port). The data payload keeps its `evt_` id — only the id line changes.
import { afterEach, describe, expect } from "bun:test"
import { Effect, Queue, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { GlobalBus } from "../../src/bus/global"
import { GlobalEventReplay } from "../../src/bus/global-replay"
import { makeSseTickTelemetry, resetSseTickTelemetry, setSseTickTelemetry } from "../../src/server/shared/sse-tick-telemetry"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(httpApiLayer)

const ID = /^([A-Za-z0-9_-]+):(\d+)$/

type Frame = { id: string | undefined; type: string; payloadID: string | undefined }

// The shared httpapi-layer request helper drops the URL's query (setUrl keeps
// only the pathname), so the query-carrying carrier dials through its own
// request — the directory rides the proven x-opencode-directory header.
const openFrames = (input: { directory: string; query?: string; headers?: Record<string, string> }) =>
  Effect.gen(function* () {
    const url = new URL(`${EventPaths.event}${input.query ?? ""}`, "http://localhost")
    const response = yield* HttpClientRequest.fromWeb(
      new Request(url, { headers: { "x-opencode-directory": input.directory, ...input.headers } }),
    ).pipe(
      HttpClientRequest.setUrl(url.pathname + url.search),
      HttpClient.execute,
    )
    const frames = yield* Queue.unbounded<Frame>()
    // SSE frames can straddle body chunks — accumulate and split on the
    // frame boundary, keeping the trailing partial block buffered.
    const state = { buffer: "" }
    yield* response.stream.pipe(
      Stream.decodeText(),
      Stream.map((chunk: string) => {
        state.buffer += chunk
        const blocks = state.buffer.split("\n\n")
        state.buffer = blocks.pop() ?? ""
        return blocks
      }),
      Stream.flatMap((blocks: Array<string>) => Stream.fromArray(blocks)),
      Stream.filter((block: string) => block.includes("data:")),
      Stream.mapEffect((block: string) =>
        Effect.sync(() => {
          const id = block.split("\n").find((line) => line.startsWith("id: "))?.slice(4)
          const data = block
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6)
          if (data === undefined) return undefined
          const payload = JSON.parse(data) as { id?: string; type: string }
          return { id, type: payload.type, payloadID: payload.id } satisfies Frame
        }),
      ),
      Stream.filter((frame): frame is Frame => frame !== undefined),
      Stream.runForEach((frame) => Queue.offer(frames, frame)),
      Effect.forkScoped,
    )
    return frames
  })

const createSession = (directory: string, title: string) =>
  Effect.gen(function* () {
    const created = yield* requestInDirectory("/session", directory, {
      method: "POST",
      body: JSON.stringify({ title }),
    })
    if (created.status !== 200) return yield* Effect.die(new Error(`session create failed: ${created.status}`))
    return title
  })

const nextFrame = (frames: Queue.Dequeue<Frame>, type: string) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 10_000
    for (;;) {
      const frame = yield* Queue.take(frames).pipe(
        Effect.timeoutOrElse({
          duration: Math.max(50, deadline - Date.now()),
          orElse: () => Effect.succeed(undefined),
        }),
      )
      if (frame === undefined) return yield* Effect.die(new Error(`timed out waiting for ${type}`))
      if (frame.type === type) return frame
    }
  })

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
  resetSseTickTelemetry()
})

describe("instance event stream — epoch:seq stamping (#1806 P1a)", () => {
  it.instance(
    "data frames carry an <epoch>:<seq> id line while the payload keeps its evt id",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const frames = yield* openFrames({ directory })
        const connected = yield* nextFrame(frames, "server.connected")
        // Control frames never consume a sequence; their id line is the
        // connection's current position, still <epoch>:<seq>-shaped.
        expect(connected.id).toMatch(ID)

        yield* createSession(directory, "p1a-stamp")
        const created = yield* nextFrame(frames, "session.created")
        expect(created.id).toMatch(ID)
        const parsed = ID.exec(created.id!)!
        expect(parsed[1]).toBe(GlobalBus.epoch)
        expect(Number(parsed[2])).toBeGreaterThan(0)
        // The payload's id is untouched — the client's dedup and cursor
        // vocabulary live there, and nothing about the data line changes.
        expect(created.payloadID).toMatch(/^evt_/)
        expect(created.payloadID).not.toBe(created.id)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})

describe("instance event stream — cursor resume against the new ids (#1806 P1a)", () => {
  // The query carrier (?lastEventID=) cannot be exercised against the bare
  // /event mount: it 400s at the schema layer on its own DECLARED query
  // fields (directory/lastEventID), while an undeclared param passes —
  // measured byte-identically against this branch's HEAD handler and the
  // ported one (the route's groups/middleware are untouched base files), so
  // it is a pre-existing mount quirk, not a port regression. Both carriers
  // ARE proven against the ported cursor machinery on the /global/event
  // route (httpapi-global-event.test.ts); the standard Last-Event-ID header
  // — the carrier a browser EventSource sends — is proven here.
  it.instance(
    "replays the gap for a Last-Event-ID header carrying the new <epoch>:<seq> id",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const live = yield* openFrames({ directory })
        yield* nextFrame(live, "server.connected")
        yield* createSession(directory, "p1a-resume-1")
        const first = yield* nextFrame(live, "session.created")
        yield* createSession(directory, "p1a-resume-2")
        yield* nextFrame(live, "session.created")

        // reconnect at the first session.created's position
        const resumed = yield* openFrames({ directory, headers: { "last-event-id": first.id! } })
        const connected = yield* nextFrame(resumed, "server.connected")
        expect(connected.id).toBe(first.id)

        // exactly the frames after the cursor: the second session, not the first
        const resumedFrames: Array<Frame | undefined> = []
        for (let i = 0; i < 9; i++) {
          const frame = yield* Queue.take(resumed).pipe(
            Effect.timeoutOrElse({ duration: "3 seconds", orElse: () => Effect.succeed(undefined) }),
          )
          resumedFrames.push(frame)
          if (frame === undefined) break
        }
        let sawFirst = false
        for (const frame of resumedFrames) {
          if (frame === undefined) continue
          if (frame.type === "session.created" && frame.payloadID === first.payloadID) sawFirst = true
        }
        expect(sawFirst).toBe(false)
        expect(resumedFrames.filter((f) => f?.type === "session.created").length).toBe(1)

        // a later live event flows exactly once through the resumed connection
        yield* createSession(directory, "p1a-resume-3")
        const later = yield* nextFrame(resumed, "session.created")
        expect(later.payloadID).not.toBe(first.payloadID)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "a legacy payload-id cursor (the lane's client vocabulary) keeps being served",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const live = yield* openFrames({ directory })
        yield* nextFrame(live, "server.connected")
        yield* createSession(directory, "p1a-legacy-1")
        const first = yield* nextFrame(live, "session.created")
        yield* createSession(directory, "p1a-legacy-2")

        // the existing client sends the last payload id it applied
        const resumed = yield* openFrames({ directory, headers: { "last-event-id": first.payloadID! } })
        yield* nextFrame(resumed, "server.connected")
        let resync = false
        let second = false
        for (let i = 0; i < 6 && !(resync || second); i++) {
          const frame = yield* Queue.take(resumed).pipe(
            Effect.timeoutOrElse({ duration: "3 seconds", orElse: () => Effect.succeed(undefined) }),
          )
          if (frame === undefined) break
          if (frame.type === "state.resync") resync = true
          if (frame.type === "session.created" && frame.payloadID !== first.payloadID) second = true
        }
        expect(resync).toBe(false)
        expect(second).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})

describe("instance event stream — the reset contract (#1806 P1a)", () => {
  const unservable: Record<string, () => string> = {
    "a cursor from a foreign epoch (an engine restart)": () => `x${GlobalBus.epoch}:1`,
    "a cursor ahead of the stream": () => `${GlobalBus.epoch}:${GlobalEventReplay.current + 1000}`,
    "a payload id older than the buffer's retention": () => "evt_0".padEnd(35, "0"),
  }
  for (const [name, cursorFor] of Object.entries(unservable)) {
    it.instance(
      `${name} yields the explicit state.resync sentinel — never a silent gap`,
      () =>
        Effect.gen(function* () {
          const { directory } = yield* TestInstance
          yield* createSession(directory, "p1a-reset-before")
          const resumed = yield* openFrames({ directory, headers: { "last-event-id": cursorFor() } })
          yield* nextFrame(resumed, "server.connected")
          const frame = yield* Queue.take(resumed).pipe(
            Effect.timeoutOrElse({ duration: "3 seconds", orElse: () => Effect.succeed(undefined) }),
          )
          expect(frame?.type).toBe("state.resync")

          // the connection is live after the reset: later events still arrive
          yield* createSession(directory, "p1a-reset-after")
          const after = yield* nextFrame(resumed, "session.created")
          expect(after.id).toMatch(ID)
        }),
      { git: true, config: { formatter: false, lsp: false } },
    )
  }
})

describe("instance event stream — liveness machinery through the port (#1798/#1804)", () => {
  it.instance(
    "heartbeats keep their cadence through the ported route and SSE-TICK lines still flow",
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
        const frames = yield* openFrames({ directory })
        yield* nextFrame(frames, "server.connected")
        const beat = yield* nextFrame(frames, "server.heartbeat")
        expect(beat.id).toMatch(ID)

        const tickLines = lines.filter((line) => line.startsWith("SSE-TICK"))
        expect(tickLines.length).toBeGreaterThanOrEqual(1)
        expect(tickLines[0]).toMatch(/^SSE-TICK route=\/event conn=\S+ cadence_ms=100 /)
        expect(lines.some((line) => line.startsWith("SELF-STALL"))).toBe(false)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
