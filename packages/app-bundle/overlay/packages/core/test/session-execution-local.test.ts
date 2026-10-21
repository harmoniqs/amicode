import { afterAll, describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { SessionRunnerLLM } from "@opencode-ai/core/session/runner/llm"
import { buildLocationServiceMap } from "@opencode-ai/core/location-services"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { RuntimeState } from "@opencode-ai/core/runtime-state"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionStore } from "@opencode-ai/core/session/store"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const tmp = await tmpdir()
afterAll(() => tmp[Symbol.asyncDispose]())

const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })

const session: SessionSchema.Info = {
  id: SessionSchema.ID.create(),
  projectID: Project.ID.global,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  title: "drain hook",
  location,
}

/** Observations captured inside the stubbed runner's drain. */
const observed: { busy: Array<{ directory: string | null }> }[] = []

// The per-location layer the drain runs against: the full location service
// group with the SessionRunner stubbed in via the node-replacement seam.
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

const locations = buildLocationServiceMap([[SessionRunnerLLM.node, runner]])

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
      expect(observed[0].busy[0].directory).toBe(tmp.path)

      // …and the release dropped it once the drain finished.
      expect((yield* runtime.busyLive(session.id)).length).toBe(0)
    }),
  )
})
