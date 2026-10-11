import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { RuntimeState } from "@opencode-ai/core/runtime-state"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { SessionStatus } from "../../src/session/status"
import { SessionRunState } from "../../src/session/run-state"
import { SessionID } from "../../src/session/schema"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// The shared runtime-state store rides along on the run-state layers.
const storeLayer = Layer.provide(RuntimeState.layer, Database.layerFromPath(":memory:"))
const layers = Layer.mergeAll(
  LayerNode.compile(
    LayerNode.group([SessionRunState.node, SessionStatus.node, EventV2Bridge.node, CrossSpawnSpawner.node]),
  ),
  testInstanceStoreLayer,
  storeLayer,
)
const lifecycle = testEffect(layers)

afterEach(async () => {
  await disposeAllInstances()
})

describe("SessionRunState shared runtime state (#1760 P2)", () => {
  lifecycle.live("lazy runner creation registers the coordinator; idle unregisters it", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const runtime = yield* RuntimeState.Service
      const sessionID = SessionID.make("ses_register")

      const result = yield* SessionRunState.Service.use((svc) =>
        svc.ensureRunning(
          sessionID,
          Effect.succeed(undefined as unknown as SessionV1.WithParts),
          Effect.gen(function* () {
            // Inside the run: the coordinator registration recorded at lazy
            // runner creation is live. (The busy row itself is a status.set
            // concern — the runner's ensureRunning path does not fire onBusy.)
            const owners = yield* runtime.ownersLive(sessionID)
            expect(owners.map((row) => row.owner_id)).toContain(RuntimeState.self.owner_id)
            expect(owners[0].directory).toBe(directory)
            return undefined as unknown as SessionV1.WithParts
          }),
        ),
      ).pipe(provideInstance(directory))
      expect(result).toBe(undefined)

      // The run went idle: the coordinator registration is gone.
      expect((yield* runtime.ownersLive(sessionID)).length).toBe(0)
      expect((yield* runtime.busyLive(sessionID)).length).toBe(0)
    }),
  )
})
