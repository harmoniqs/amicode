import { Session } from "@/session/session"
import { SessionID as SessionIDType } from "@opencode-ai/schema/session-id"
import { SessionTodo } from "@opencode-ai/schema/session-todo"
import { Event as QuestionEvent } from "@/question"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { mkdir } from "node:fs/promises"
import { Config, Effect, Layer, Queue } from "effect"
import * as Scope from "effect/Scope"
import { Database } from "@opencode-ai/core/database/database"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import * as Stream from "effect/Stream"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { registerAdapter } from "../../src/control-plane/adapters"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideInstanceEffect, tmpdirScoped } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"

const originalWorkspaces = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES

const localAdapter = (directory: string): WorkspaceAdapter => ({
  name: "Local Test",
  description: "Create a local test workspace",
  configure: (info) => ({ ...info, name: "local-test", directory }),
  create: async () => {
    await mkdir(directory, { recursive: true })
  },
  async remove() {},
  target: () => ({ type: "local" as const, directory }),
})

const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ run: Effect.void }),
)
const appLayer = AppNodeBuilder.build(
  LayerNode.group([InstanceStore.node, Project.node, Session.node, Workspace.node, Database.node, Ripgrep.node]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(HttpApiApp.routes, {
  disableListenLog: true,
  disableLogger: true,
})
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const eventsLayer = LayerNode.compile(LayerNode.group([EventV2Bridge.node]))
const it = testEffectShared(Layer.mergeAll(appLayer, httpApiLayer))

type SseEvent = { id?: string; type: string; properties?: unknown }

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname + url.search),
    HttpClient.execute,
  )
}

function sseFromResponse(response: HttpClientResponse.HttpClientResponse) {
  const state = { buffer: "" }
  return response.stream.pipe(
    Stream.decodeText(),
    Stream.map((chunk: string) => {
      state.buffer += chunk
      const frames = state.buffer.split("\n\n")
      state.buffer = frames.pop() ?? ""
      return frames
    }),
    Stream.flatMap((frames: Array<string>) => Stream.fromArray(frames)),
    Stream.filter((frame: string) => frame.includes("data:")),
    Stream.map((frame: string) => {
      const line = frame
        .split("\n")
        .find((candidate) => candidate.startsWith("data:"))
        ?.slice("data:".length)
      return line === undefined ? undefined : (JSON.parse(line.trim()) as SseEvent)
    }),
    Stream.filter((event): event is SseEvent => event !== undefined),
  )
}

function collectSse(path: string, count: number, init?: RequestInit) {
  return Effect.gen(function* () {
    const response = yield* request(path, init)
    if (response.status !== 200) {
      const text = yield* Effect.orDie(response.text)
      return yield* Effect.die(new Error(`sse status ${response.status}: ${text.slice(0, 400)}`))
    }
    // Time-bounded rather than count-bounded: unrelated instance-lifecycle
    // events may arrive (or not), so waiting for exactly `count` frames can
    // stall; halt after 2s of stream time and assert on what arrived.
    const events = yield* sseFromResponse(response)
      .pipe(Stream.timeout("2 seconds"), Stream.take(count), Stream.runCollect)
      .pipe(Effect.orDie)
    return Array.from(events)
  }).pipe(Effect.scoped)
}

// No trailing Effect.scoped on purpose: the response and drain fiber must
// live in the test body's ambient scope, not one that closes when openSse
// returns — the reconnect flows below read from this connection afterward.
function openSse(path: string, init?: RequestInit) {
  return Effect.gen(function* () {
    const queue = yield* Queue.unbounded<SseEvent, any>()
    const response = yield* request(path, init)
    if (response.status !== 200) return yield* Effect.die(new Error(`sse status ${response.status}`))
    yield* sseFromResponse(response).pipe(Stream.runIntoQueue(queue), Effect.forkScoped)
    return queue
  })
}

const eventPath = (directory: string, query?: string) =>
  // The httpapi mount is /api-prefixed in tests; production clients reach the
  // same route through the frontdoor's /event alias.
  `/api${EventPaths.event}?directory=${encodeURIComponent(directory)}${query ? `&${query}` : ""}`

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
})

describe("event SSE replay", () => {
  // The routes' event bus instances resolve through the process-wide memoMap
  // (the same one Server.Default uses), so a body-side layer built through it
  // publishes onto the very bus the SSE routes listen to.
  const publishEvent = (definition: any, data: any) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const ctx = yield* Layer.buildWithMemoMap(eventsLayer, memoMap, scope)
      const bridge = yield* EventV2Bridge.Service.pipe(Effect.provide(ctx))
      const event = yield* bridge.publish(definition, data)
      return event.id
    }).pipe(Effect.orDie)

  const publishTodo = (sessionID: SessionIDType, content: string) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const ctx = yield* Layer.buildWithMemoMap(eventsLayer, memoMap, scope)
      const bridge = yield* EventV2Bridge.Service.pipe(Effect.provide(ctx))
      const event = yield* bridge.publish(SessionTodo.Event.Updated, {
        sessionID,
        todos: [{ content, status: "pending", priority: "high" }],
      })
      return event.id
    }).pipe(Effect.orDie)

  const mentionsText = (event: SseEvent, text: string): boolean =>
    event.id !== undefined && JSON.stringify(event).includes(text)

  // todo.updated only needs a SessionID-shaped string ("ses" prefix) — a real
  // session would drag the session projector into cross-test state.
  const setupSession = (sessionID: SessionIDType) =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true, config: { formatter: false, lsp: false } })
      return { directory, sessionID }
    })

  it.live("replays the gap for a reconnecting lastEventID query cursor", () =>
    Effect.gen(function* () {
      const { directory, sessionID } = yield* setupSession(SessionIDType.make("ses_sse_replay_1"))
      const path = eventPath(directory)
      const queue = yield* openSse(path)
      yield* Queue.take(queue)
      yield* publishTodo(sessionID, "replay-m1")
      yield* publishTodo(sessionID, "replay-m2")
      yield* publishTodo(sessionID, "replay-m3")
      let cursor: string | undefined
      while (cursor === undefined) {
        const next = yield* Queue.take(queue).pipe(Effect.timeout("10 seconds"), Effect.orDie)
        if (mentionsText(next, "replay-m3")) cursor = next.id
      }

      yield* publishTodo(sessionID, "replay-m4")

      const reconnected = yield* collectSse(eventPath(directory, `lastEventID=${cursor}`), 8)

      expect(reconnected.some((event) => event.type === "state.resync")).toBe(false)
      expect(reconnected.some((event) => mentionsText(event, "replay-m4"))).toBe(true)
      expect(reconnected.some((event) => mentionsText(event, "replay-m3"))).toBe(false)
      expect(reconnected.some((event) => mentionsText(event, "replay-m2"))).toBe(false)
    }).pipe(Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  it.live("replays the same gap for the standard Last-Event-ID header", () =>
    Effect.gen(function* () {
      const { directory, sessionID } = yield* setupSession(SessionIDType.make("ses_sse_replay_2"))
      const queue = yield* openSse(eventPath(directory))
      yield* Queue.take(queue)
      yield* publishTodo(sessionID, "replay-m1")
      yield* publishTodo(sessionID, "replay-m2")
      let cursor: string | undefined
      while (cursor === undefined) {
        const next = yield* Queue.take(queue).pipe(Effect.timeout("10 seconds"), Effect.orDie)
        if (mentionsText(next, "replay-m2")) cursor = next.id
      }

      yield* publishTodo(sessionID, "replay-m3")

      const reconnected = yield* collectSse(eventPath(directory), 8, { headers: { "last-event-id": cursor } })

      expect(reconnected.some((event) => event.type === "state.resync")).toBe(false)
      expect(reconnected.some((event) => mentionsText(event, "replay-m3"))).toBe(true)
      expect(reconnected.some((event) => mentionsText(event, "replay-m2"))).toBe(false)
    }).pipe(Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  it.live("V1-named events survive the V2 encoder and reach live subscribers", () =>
    // 2026-10-10: the engine publishes question.asked (V1 name — the V1
    // question service the live routes use); the V2 wire schema rejects it
    // and the THROWING encoder killed the stream at the first question —
    // the panel's session view went dark mid-turn, cards only surfaced on
    // reload (list fetch). The encoder now carries unknown-shaped events
    // raw. A raw question.asked publish must (a) reach the /api/event
    // subscriber, (b) not kill the stream, (c) still deliver events after.
    Effect.gen(function* () {
      const directory = yield* setupSession("ses_v1live")
      const queue = yield* openSse(eventPath(directory))
      yield* Queue.take(queue) // server.connected

      const before = yield* publishTodo(SessionIDType.make("ses_v1live"), "before")
      yield* publishEvent(QuestionEvent.Asked, {
        id: "que_v1live",
        sessionID: SessionIDType.make("ses_v1live"),
        questions: [{ header: "h", question: "live?", options: [{ label: "a", description: "d" }] }],
      })
      const after = yield* publishTodo(SessionIDType.make("ses_v1live"), "after")

      let sawQuestion = false
      let seen = 0
      while (seen < 2 || !sawQuestion) {
        const next = yield* Queue.take(queue).pipe(Effect.timeout("10 seconds"), Effect.orDie)
        if (next.id === before || next.id === after) {
          seen++
          continue
        }
        if (String(next.type).includes("question")) sawQuestion = true
      }
      expect(sawQuestion).toBe(true)
    }).pipe(Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  it.live("emits state.resync when the cursor predates ring retention", () =>
    Effect.gen(function* () {
      const { directory, sessionID } = yield* setupSession(SessionIDType.make("ses_sse_replay_3"))
      yield* publishTodo(sessionID, "replay-old")

      const events = yield* collectSse(eventPath(directory, `lastEventID=${"evt_0".padEnd(35, "0")}`), 2)

      expect(events.map((event) => event.type)).toEqual(["server.connected", "state.resync"])
    }).pipe(Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  it.live("live events flow exactly once after a replayed preamble", () =>
    Effect.gen(function* () {
      const { directory, sessionID } = yield* setupSession(SessionIDType.make("ses_sse_replay_4"))
      const queue = yield* openSse(eventPath(directory))
      yield* Queue.take(queue)
      yield* publishTodo(sessionID, "replay-m1")
      let cursor: string | undefined
      while (cursor === undefined) {
        const next = yield* Queue.take(queue).pipe(Effect.timeout("10 seconds"), Effect.orDie)
        if (mentionsText(next, "replay-m1")) cursor = next.id
      }

      const reconnected = yield* openSse(eventPath(directory, `lastEventID=${cursor}`))
      const connected = yield* Queue.take(reconnected)
      expect(connected.type).toBe("server.connected")

      const liveID = yield* publishTodo(sessionID, "replay-live")
      let live: SseEvent | undefined
      let duplicates = 0
      while (live === undefined) {
        const next = yield* Queue.take(reconnected).pipe(Effect.timeout("10 seconds"), Effect.orDie)
        if (next.id === liveID) live = next
      }
      expect(live.type).toBe("todo.updated")
      const drain = yield* Queue.take(reconnected).pipe(Effect.timeout("1 seconds"), Effect.exit)
      if (drain._tag === "Success" && drain.value.id === liveID) {
        duplicates++
      }
      expect(duplicates).toBe(0)
    }).pipe(Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )
})
