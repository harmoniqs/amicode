import { afterEach, describe, expect } from "bun:test"
import { Duration, Effect, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { RuntimeState } from "@opencode-ai/core/runtime-state"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { SessionStatus } from "../../src/session/status"
import { SessionID } from "../../src/session/schema"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// The shared runtime-state store rides along on the status layers.
const storeLayer = Layer.provide(RuntimeState.layer, Database.layerFromPath(":memory:"))
const layers = Layer.mergeAll(
  LayerNode.compile(LayerNode.group([SessionStatus.node, EventV2Bridge.node, CrossSpawnSpawner.node])),
  testInstanceStoreLayer,
  storeLayer,
)
const lifecycle = testEffect(layers)

afterEach(async () => {
  await disposeAllInstances()
})

describe("SessionStatus shared runtime state (#1760 P2)", () => {
  lifecycle.effect("a busy claim appears with its directory, heartbeats across the TTL, and idle releases it", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const runtime = yield* RuntimeState.Service
      const sessionID = SessionID.make("ses_busy")

      yield* SessionStatus.Service.use((svc) => svc.set(sessionID, { type: "busy" })).pipe(provideInstance(directory))
      let live = yield* runtime.busyLive(sessionID)
      expect(live.length).toBe(1)
      expect(live[0].owner_id).toBe(RuntimeState.self.owner_id)
      expect(live[0].directory).toBe(directory)

      // The scoped heartbeat fiber keeps the row live well past the TTL.
      yield* TestClock.adjust(Duration.seconds(30))
      live = yield* runtime.busyLive(sessionID)
      expect(live.length).toBe(1)

      yield* SessionStatus.Service.use((svc) => svc.set(sessionID, { type: "idle" })).pipe(provideInstance(directory))
      live = yield* runtime.busyLive(sessionID)
      expect(live.length).toBe(0)

      // The heartbeat fiber is gone: no late writes resurrect the row.
      yield* TestClock.adjust(Duration.seconds(30))
      live = yield* runtime.busyLive(sessionID)
      expect(live.length).toBe(0)
    }),
  )

  lifecycle.effect("a retry status is still a live claim", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const runtime = yield* RuntimeState.Service
      const sessionID = SessionID.make("ses_retry")

      yield* SessionStatus.Service.use((svc) =>
        svc.set(sessionID, { type: "retry", attempt: 1, message: "provider hiccup", next: 2 }),
      ).pipe(provideInstance(directory))
      const live = yield* runtime.busyLive(sessionID)
      expect(live.length).toBe(1)

      yield* SessionStatus.Service.use((svc) => svc.set(sessionID, { type: "idle" })).pipe(provideInstance(directory))
      expect((yield* runtime.busyLive(sessionID)).length).toBe(0)
    }),
  )

  lifecycle.effect("a second owner's busy claim is a visible double ownership", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const runtime = yield* RuntimeState.Service
      const sessionID = SessionID.make("ses_double")

      // This instance claims the session busy…
      yield* SessionStatus.Service.use((svc) => svc.set(sessionID, { type: "busy" })).pipe(provideInstance(directory))
      // …and another owner process claims it too.
      yield* runtime.busyEnter({
        sessionID,
        directory: "/elsewhere",
        owner: { owner_id: "own_other", pid: 999 },
      })

      const live = yield* runtime.busyLive(sessionID)
      expect(live.map((row) => row.owner_id).sort()).toEqual(["own_other", RuntimeState.self.owner_id].sort())
      // Every live claim carries the advisory conflict marker from the store.
      expect(live.every((row) => row.conflict)).toBe(true)
    }),
  )
})
