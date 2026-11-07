/**
 * #1814 P3 (lane adaptation of main's 06eac851) — the instance /event route
 * is the wire the APP's session view consumes, and unlike main this engine
 * serves TWO wire shapes off the one replay buffer: the global route streams
 * the buffer's serialized `data` (main's shape, stripped once at emit), while
 * the instance route projects its payload view from the frame's live `event`
 * object. The patch-body cut must hold on BOTH wires: a summary-bearing
 * message.updated reaches this route with file, status and counts and no patch
 * text, and the frame stays under #1803's per-frame ceiling. The stored
 * message (the on-demand patch source) is untouched — proven end-to-end in
 * summary-diff-wire.test.ts.
 */
import { afterEach, describe, expect } from "bun:test"
import { Effect, Queue, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(httpApiLayer)

const KB = 1024
const STRIP_CEILING = 256 * KB

type Block = { id: string | undefined; bytes: number; data: string }

// The raw-block variant of the sequencing suite's openFrames: every SSE block
// with its whole on-the-wire size (the byte number the ceiling asserts on).
const openBlocks = (input: { directory: string; headers?: Record<string, string> }) =>
  Effect.gen(function* () {
    const url = new URL(EventPaths.event, "http://localhost")
    const response = yield* HttpClientRequest.fromWeb(
      new Request(url, { headers: { "x-opencode-directory": input.directory, ...input.headers } }),
    ).pipe(
      HttpClientRequest.setUrl(url.pathname + url.search),
      HttpClient.execute,
    )
    const blocks = yield* Queue.unbounded<Block>()
    // SSE frames can straddle body chunks — accumulate and split on the
    // frame boundary, keeping the trailing partial block buffered.
    const state = { buffer: "" }
    yield* response.stream.pipe(
      Stream.decodeText(),
      Stream.map((chunk: string) => {
        state.buffer += chunk
        const frames = state.buffer.split("\n\n")
        state.buffer = frames.pop() ?? ""
        return frames
      }),
      Stream.flatMap((frames: Array<string>) => Stream.fromArray(frames)),
      Stream.filter((frame: string) => frame.includes("data:")),
      Stream.mapEffect((frame: string) =>
        Effect.sync(() => {
          const lines = frame.split("\n")
          const data = lines.find((line) => line.startsWith("data: "))?.slice(6)
          if (data === undefined) return undefined
          const id = lines.find((line) => line.startsWith("id: "))?.slice(4)
          return { id, bytes: Buffer.byteLength(frame) + 2, data } satisfies Block
        }),
      ),
      Stream.filter((block): block is Block => block !== undefined),
      Stream.runForEach((block) => Queue.offer(blocks, block)),
      Effect.forkScoped,
    )
    return blocks
  })

const nextBlock = (blocks: Queue.Dequeue<Block>) =>
  Queue.take(blocks).pipe(
    Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.die(new Error("timed out waiting for block")) }),
  )

/** Skip to the frame of `type`, decoding the last one seen on the way. */
const untilType = (blocks: Queue.Dequeue<Block>, type: string) =>
  Effect.gen(function* () {
    for (;;) {
      const block = yield* nextBlock(blocks)
      const parsed = JSON.parse(block.data) as { type: string }
      if (parsed.type === type) return block
    }
  })

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const diffs = [
  { file: "src/app.ts", patch: "@@ -1,2 +1,2 @@\n-old line\n+new line\n context\n", additions: 1, deletions: 1, status: "modified" as const },
  { file: `src/new.ts`, patch: `@@ -0,0 +1,3000 @@\n${"+x\n".repeat(3000)}`, additions: 3000, deletions: 0, status: "added" as const },
]
const stripped = () => diffs.map(({ patch: _patch, ...rest }) => rest)

describe("instance event stream — summary diffs carry no patch bodies (#1814 P3 lane adaptation)", () => {
  it.instance(
    "a summary-bearing message.updated reaches the app's wire stripped and under the ceiling; the bus payload keeps the patches",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const blocks = yield* openBlocks({ directory })
        yield* untilType(blocks, "server.connected")

        const seen: GlobalEvent[] = []
        const listener = (event: GlobalEvent) => seen.push(event)
        GlobalBus.on("event", listener)
        yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

        const event: GlobalEvent = {
          directory,
          payload: {
            id: "evt_i1814_strip",
            type: "message.updated",
            properties: {
              sessionID: "ses_i1814",
              info: { id: "msg_i1814", sessionID: "ses_i1814", role: "user", summary: { title: "Edit", diffs } },
            },
          },
        }
        GlobalBus.emit("event", event)

        const block = yield* untilType(blocks, "message.updated")
        const parsed = JSON.parse(block.data)
        // the wire keeps the file list and counts and drops every patch body
        expect(parsed.properties.info.summary.diffs).toEqual(stripped())
        expect(parsed.properties.info.summary.title).toBe("Edit")
        expect(block.data).not.toContain('"patch"')
        // the frame stays under #1803's per-frame ceiling
        expect(block.bytes).toBeLessThan(STRIP_CEILING)
        // the projection is wire-only: in-process subscribers see the full event
        expect(seen.find((candidate) => candidate.payload.type === "message.updated")?.payload.properties.info.summary.diffs).toEqual(diffs)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "a replayed summary frame through the instance route is stripped too",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const live = yield* openBlocks({ directory })
        const connected = yield* untilType(live, "server.connected")
        // the control frame's id line is the connection's position — the
        // sequence the summary event will follow.
        const cursor = (JSON.parse(connected.data) as { id?: string }).id

        GlobalBus.emit("event", {
          directory,
          payload: {
            id: "evt_i1814_replay_src",
            type: "message.updated",
            properties: {
              sessionID: "ses_i1814",
              info: { id: "msg_i1814r", sessionID: "ses_i1814", role: "user", summary: { title: "Edit", diffs } },
            },
          },
        })
        const liveBlock = yield* untilType(live, "message.updated")
        const liveParsed = JSON.parse(liveBlock.data)

        // reconnect from the pre-event position: the replayed summary frame is
        // the same stripped shape (the shared buffer serves both routes'
        // replay paths).
        const resumed = yield* openBlocks({ directory, headers: { "last-event-id": cursor! } })
        yield* untilType(resumed, "server.connected")
        const replayed = yield* untilType(resumed, "message.updated")
        const replayedParsed = JSON.parse(replayed.data)
        expect((replayedParsed as { id?: string }).id).toBe((liveParsed as { id?: string }).id)
        expect(replayedParsed.properties.info.summary.diffs).toEqual(liveParsed.properties.info.summary.diffs)
        expect(replayed.data).not.toContain('"patch"')
        expect(replayed.bytes).toBeLessThan(STRIP_CEILING)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
