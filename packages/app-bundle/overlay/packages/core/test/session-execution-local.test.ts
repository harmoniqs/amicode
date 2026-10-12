import { describe, expect } from "bun:test"
import { Effect, Layer, LayerMap } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { Location } from "@opencode-ai/core/location"
import { RuntimeState } from "@opencode-ai/core/runtime-state"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionStore } from "@opencode-ai/core/session/store"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { testEffect } from "./lib/effect"

const location = Location.Ref.make({ directory: AbsolutePath.make("/drain") })

const session: SessionSchema.Info = {
  id: SessionSchema.ID.create(),
  projectID: "global",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: new Date(0), updated: new Date(0) },
  title: "drain hook",
  location,
}

/** Observations captured inside the stubbed runner's drain. */
const observed: { busy: Array<{ directory: string | null }> }[] = []

// The per-location layer the drain runs against: a stubbed SessionRunner.
const runner = Layer.succeed(
  SessionRunner.Service,
  SessionRunner.Service.of({
    run: () =>
      Effect.gen(function* () {
        const runtime = RuntimeState.getGlobal()
        const busy = runtime ? yield* runtime.busyLive(session.id) : []
        observed.push({ busy: busy.map((row) => ({ directory: row.directory })) })
      }),
    compact: () => Effect.succeed(false),
  }),
)

const store = Layer.succeed(
  SessionStore.Service,
  SessionStore.Service.of({
    get: (sessionID) => Effect.succeed(sessionID === session.id ? session : undefined),
    context: () => Effect.die("not used"),
    runnerContext: () => Effect.die("not used"),
    message: () => Effect.die("not used"),
  }),
)

const locations = Layer.unwrap(
  Effect.map(LayerMap.make(() => runner), (map) => Layer.succeed(LocationServiceMap.Service, map)),
)

const it = testEffect(
  Layer.mergeAll(
    AppNodeBuilder.build(LayerNode.group([SessionExecutionLocal.node]), [
      [SessionStore.node, store],
      [LocationServiceMap.node, locations],
    ]),
    Layer.provide(RuntimeState.layer, Database.layerFromPath(":memory:")),
  ),
)

describe("SessionExecutionLocal shared runtime state (#1760 P2)", () => {
  it.effect("a drain claims the session busy for its duration", () =>
    Effect.gen(function* () {
      const execution = yield* SessionExecution.Service
      const runtime = yield* RuntimeState.Service

      expect((yield* runtime.busyLive(session.id)).length).toBe(0)
      yield* execution.resume(session.id)

      // The stubbed runner observed the busy row (with the session's
      // directory) while the drain was running…
      expect(observed).toHaveLength(1)
      expect(observed[0].busy).toHaveLength(1)
      expect(observed[0].busy[0].directory).toBe("/drain")

      // …and the release dropped it once the drain finished.
      expect((yield* runtime.busyLive(session.id)).length).toBe(0)
    }),
  )
})
